# @dakaio/sequelize-transactional

`@Transactional()` for [Sequelize](https://sequelize.org) and [sequelize-typescript](https://github.com/sequelize/sequelize-typescript): register the app's connection once, decorate the methods that write, and nested calls join one transaction. The database's own clock comes with it: one "now" for every app server.

```ts
@Injectable()
export class OrdersService {
  constructor(private readonly stock: StockService) {} // no connection injected

  @Transactional()
  async place(item: string, quantity: number, transaction?: Transaction): Promise<Order> {
    const order = await Order.create({ item, quantity }, { transaction });
    await this.stock.take(item, quantity); // decorated too: runs in this same transaction
    return order;
  }
}
```

- **One registration at boot.** No service injects a connection for the decorator's sake.
- **Nested calls join.** A decorated method called inside another one's transaction runs in it; only the outermost commits or rolls back.
- **`currentTransaction()`** reaches the running transaction from code that is not a decorated method, such as a helper several services share.
- **The database clock.** `databaseNow()` and `readDatabaseNow()` take "now" from Postgres, so every app server agrees on it.
- **No dependencies.** It works on the shape of the app's connection, never on Sequelize's classes, so it survives a linked or non-deduped install where `instanceof Sequelize` would fail.


## The problems it solves

### Every service injects a connection

Sequelize opens a transaction from the connection, `sequelize.transaction(async (transaction) => ...)`. So every service that writes injects the connection only to open transactions, and hands the transaction down through every call by hand:

```ts
// Without the package: the connection injected everywhere, the transaction passed by hand.
@Injectable()
export class OrdersService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly stock: StockService,
  ) {}

  place(item: string, quantity: number): Promise<Order> {
    return this.sequelize.transaction(async (transaction) => {
      const order = await Order.create({ item, quantity }, { transaction });
      await this.stock.take(item, quantity, transaction);
      return order;
    });
  }
}
```

With the package the app registers its connection once, and a decorated method gets its transaction as its last argument. No service injects the connection, and nested decorated calls find the transaction on their own.

### Nested transactions wait on each other's locks

Sooner or later a method that opens a transaction calls another method that opens one too. The inner one does not join: it opens a second transaction, on a second connection from the pool. Once the outer transaction has locked a row (by writing it, or by reading it `FOR UPDATE`) and the inner one writes the same row, the inner transaction waits for the outer one to end, while the outer one waits for the inner method to return. Postgres sees only one of the two waits (the other is in the app), so it reports no deadlock: the request hangs until a timeout, holding two connections, and enough such requests at once drain the pool.

A decorated method called inside another one's transaction runs in that same transaction: the same connection, the same locks, nothing to wait for.

### Every app server has its own clock

`new Date()` is the clock of whichever server runs the code. Several app servers are several clocks, each a little off, any of them drifted or set up wrong: "is this reminder due?" gets a different answer depending on where it is asked, and timestamps written by two instances do not compare cleanly. The database is one clock for all of them, and the one the rows are written against. `databaseNow()` puts its `now()` into a query, and `readDatabaseNow()` reads it into the app.

## Install

```sh
pnpm add @dakaio/sequelize-transactional
```

With npm: `npm install @dakaio/sequelize-transactional`.

What it expects from the app:

- **Node.js 18** or later.
- **Sequelize 6**, plain or through `sequelize-typescript`. The package has no dependencies and never imports Sequelize: it works with the connection the app hands it.
- **`experimentalDecorators`** in `tsconfig.json`, which NestJS and `sequelize-typescript` projects already have on. The newer standard decorators are not supported.
- **Postgres** for the clock: inside a transaction its `now()` is the moment the transaction began. The decorator itself only opens, commits and rolls back transactions; the package is tested against Postgres.

## Quick start

### NestJS

The root module registers the connection; services decorate the methods that write.

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { InjectConnection, SequelizeModule } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { useTransactionalConnection } from '@dakaio/sequelize-transactional';

import { OrdersModule } from './orders/orders.module';

/** The environment variables the app is configured through. */
const ENV = {
  /** Where the database is: postgres://user:password@host:port/database. */
  DATABASE_URL: 'DATABASE_URL',
} as const;

@Module({
  imports: [
    SequelizeModule.forRoot({ uri: process.env[ENV.DATABASE_URL], autoLoadModels: true }),
    OrdersModule,
  ],
})
export class AppModule {
  constructor(@InjectConnection() sequelize: Sequelize) {
    // Once, at boot: every @Transactional() method opens its transactions on this connection.
    useTransactionalConnection(sequelize);
  }
}
```

```ts
// orders/orders.models.ts
import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table
export class Order extends Model {
  /** What was ordered. */
  @Column(DataType.TEXT)
  public item: string;

  /** How many of it. */
  @Column(DataType.INTEGER)
  public quantity: number;
}

@Table
export class Stock extends Model {
  /** The item: one row each. */
  @Column({ type: DataType.TEXT, unique: true })
  public item: string;

  /** How many of it are left. */
  @Column(DataType.INTEGER)
  public left: number;
}
```

```ts
// orders/orders.services.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Transaction } from 'sequelize';
import { Transactional } from '@dakaio/sequelize-transactional';

import { Order, Stock } from './orders.models';

/** More of an item was asked for than is left. */
export class OutOfStockError extends Error {}

@Injectable()
export class StockService {
  constructor(@InjectModel(Stock) private readonly stock: typeof Stock) {}

  /** Takes items from stock, or throws when there are not enough of them. */
  @Transactional()
  async take(item: string, quantity: number, transaction?: Transaction): Promise<void> {
    // Locked until the transaction ends: two orders cannot both take the last ones.
    const stock = await this.stock.findOne({ where: { item }, lock: true, transaction });
    const enough = stock !== null && stock.left >= quantity;
    if (!enough) {
      throw new OutOfStockError(item);
    }
    await stock.decrement({ left: quantity }, { transaction });
  }
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order) private readonly orders: typeof Order,
    private readonly stock: StockService,
  ) {}

  /** Places an order and takes its items from stock: both, or neither. */
  @Transactional()
  async place(item: string, quantity: number, transaction?: Transaction): Promise<Order> {
    const order = await this.orders.create({ item, quantity }, { transaction });
    await this.stock.take(item, quantity); // decorated too: runs in this same transaction
    return order;
  }
}
```

```ts
// orders/orders.module.ts
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';

import { Order, Stock } from './orders.models';
import { OrdersService, StockService } from './orders.services';

@Module({
  imports: [SequelizeModule.forFeature([Order, Stock])],
  providers: [OrdersService, StockService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

When `take()` throws, the order `place()` has created is rolled back with it, and `place()` rejects with the `OutOfStockError` for its caller to answer.

### Plain Sequelize

The same without NestJS: register the connection as soon as it exists.

```ts
import { DataTypes, Model, Sequelize, type Transaction } from 'sequelize';
import { Transactional, useTransactionalConnection } from '@dakaio/sequelize-transactional';

/** The environment variables the app is configured through. */
const ENV = {
  /** Where the database is: postgres://user:password@host:port/database. */
  DATABASE_URL: 'DATABASE_URL',
} as const;

const databaseUrl = process.env[ENV.DATABASE_URL];
if (!databaseUrl) {
  throw new Error(`${ENV.DATABASE_URL} is not set`);
}
const sequelize = new Sequelize(databaseUrl);

// Once, before any decorated method runs.
useTransactionalConnection(sequelize);

/** A balance, in cents, that never goes below zero. */
class Account extends Model {
  declare id: number;
  declare balance: number;
}
Account.init({ balance: { type: DataTypes.INTEGER, allowNull: false } }, { sequelize });

/** A withdrawal larger than the balance. */
class InsufficientFundsError extends Error {}

class Accounts {
  /** Moves money from one account to another: both sides, or neither. */
  @Transactional()
  async transfer(from: number, to: number, cents: number): Promise<void> {
    await this.withdraw(from, cents); // decorated too: joins this transaction
    await this.deposit(to, cents);
  }

  @Transactional()
  async withdraw(id: number, cents: number, transaction?: Transaction): Promise<void> {
    const account = await Account.findByPk(id, { lock: true, rejectOnEmpty: true, transaction });
    const enough = account.balance >= cents;
    if (!enough) {
      throw new InsufficientFundsError();
    }
    await account.decrement({ balance: cents }, { transaction });
  }

  @Transactional()
  async deposit(id: number, cents: number, transaction?: Transaction): Promise<void> {
    await Account.increment({ balance: cents }, { where: { id }, transaction });
  }
}
```

`new Accounts().transfer(payer.id, payee.id, price)` either moves the money or, when the withdrawal throws, leaves both balances as they were. `transfer()` runs no query itself, so it does not declare the transaction parameter: the decorator appends it all the same, and JavaScript ignores it.

## Register the connection

`useTransactionalConnection(connection, options?)` tells `@Transactional()` which connection to open transactions on. Call it once, as early as the app has its connection: in NestJS the root module's constructor, as in the [quick start](#nestjs); without NestJS, right after `new Sequelize(...)`.

- Classes are decorated as their modules load, long before anything is registered. That is fine: a decorated method looks the connection up on every call.
- A second call replaces the first, options included: an option left out is cleared.
- `registeredTransactionalConnection()` answers the registered connection (or `undefined` before one is), for helpers of the app's own that work on it.
- The one option, `onRollback`, is described in [Log rollbacks](#log-rollbacks).

## Decorate a method

```ts
@Transactional()
async cancel(id: number, transaction?: Transaction): Promise<void> {
  await Order.update({ cancelledAt: databaseNow() }, { where: { id }, transaction });
}
```

- **The transaction is the last argument.** The decorator appends it after the arguments the caller passed: declare it as the method's last parameter, optional, and leave it out when calling. A query takes part by being handed it (`{ transaction }`); a query that is not runs [outside the transaction](#a-query-that-is-not-handed-the-transaction-runs-outside-it).
- **Commit on return, rollback on throw.** The caller gets the method's result once the transaction is committed, or the method's own error, unchanged, once it is rolled back.
- **Always async.** The decorated method returns a promise whatever it returned before: decorate async methods.
- **The try/catch stays in the caller.** A part of a method that must be all or nothing becomes a decorated method of its own (a private one is fine), and the caller catches what it throws, after the rollback.

## Nested calls join one transaction

A decorated method called inside another one's transaction runs in that same transaction:

```ts
@Transactional()
async place(item: string, quantity: number, transaction?: Transaction): Promise<Order> {
  const order = await this.orders.create({ item, quantity }, { transaction });
  await this.stock.take(item, quantity); // receives this transaction as its last argument
  return order;
}
```

- The inner method receives the outer transaction as its last argument and neither commits nor rolls back: the outermost method does, once, for everything.
- An error the inner method throws reaches the outer one; when the outer one lets it go, everything both of them wrote is rolled back.
- The inner method can write a row the outer one has locked: it is the same transaction, so there is nothing to wait for.
- Called on its own, the inner method opens and ends a transaction of its own.

The one thing to avoid is catching the inner method's error inside the transaction: see [Caveats](#catching-an-inner-error-does-not-undo-it).

## Reach the transaction from anywhere

`currentTransaction()` answers the transaction the calling code runs inside, for code that a decorated method calls but that is not decorated itself:

```ts
import type { Transaction } from 'sequelize';
import { currentTransaction } from '@dakaio/sequelize-transactional';

import { AuditEntry } from './audit-entry.model';

/** What an audit entry records. */
export const AUDIT_ACTION = {
  /** An order was placed. */
  ORDER_PLACED: 'ORDER_PLACED',
  /** An order was cancelled. */
  ORDER_CANCELLED: 'ORDER_CANCELLED',
} as const;
export type AUDIT_ACTION = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/**
 * Writes an audit entry in the transaction the caller runs in, so it is rolled back with
 * everything else; called outside one, the entry is written on its own.
 */
export const audit = (action: AUDIT_ACTION, orderId: number): Promise<AuditEntry> =>
  AuditEntry.create({ action, orderId }, { transaction: currentTransaction<Transaction>() });
```

```ts
@Transactional()
async place(item: string, quantity: number, transaction?: Transaction): Promise<Order> {
  const order = await this.orders.create({ item, quantity }, { transaction });
  await audit(AUDIT_ACTION.ORDER_PLACED, order.id); // no transaction to pass: it finds it
  return order;
}
```

- It is `undefined` outside a decorated method, and again once the method has returned.
- The type parameter is the type to see the transaction as: `currentTransaction<Transaction>()` for Sequelize's own, to reach `transaction.LOCK`, say. It defaults to the package's `TransactionLike`.
- It follows the call chain across `await`, timers and callbacks, and concurrent requests never see each other's transaction.

## The database clock

Why the database's clock rather than the app server's: [every app server has its own clock](#every-app-server-has-its-own-clock). Store the columns it fills as `timestamptz` (Sequelize's `DATE` on Postgres): an absolute instant, whatever time zone each server runs in.

### databaseNow(): now() inside the query

```ts
import { Op, type Transaction } from 'sequelize';
import { databaseNow, Transactional } from '@dakaio/sequelize-transactional';

import { Order, Reminder } from './models';

export class RemindersService {
  /** Every reminder that is due, by the database's clock. */
  due(): Promise<Reminder[]> {
    return Reminder.findAll({ where: { sendAt: { [Op.lte]: databaseNow() } } });
  }
}

export class OrdersService {
  /** Cancels the order, stamped by the database's clock with no round trip to read it first. */
  @Transactional()
  async cancel(id: number, transaction?: Transaction): Promise<void> {
    await Order.update({ cancelledAt: databaseNow() }, { where: { id }, transaction });
  }
}
```

- It is `sequelize.fn('now')`, built with the app's own connection: the database works it out when the query runs.
- Run inside a transaction, it is the moment that transaction began, so every row the transaction stamps carries the same instant.
- Some Sequelize typings (`create`, `bulkCreate`, `upsert`) do not accept a SQL function as a value: read the instant with `readDatabaseNow()` for those.
- It builds on the registered connection; `databaseNow(sequelize)` builds on another.

### readDatabaseNow(): now() read into the app

```ts
import type { Transaction } from 'sequelize';
import { readDatabaseNow, Transactional } from '@dakaio/sequelize-transactional';

import { Offer } from './offer.model';

/** The offer was taken after it expired. */
export class OfferExpiredError extends Error {}

export class OffersService {
  /** Takes the offer for the client, while it is open. */
  @Transactional()
  async claim(offerId: number, clientId: number, transaction?: Transaction): Promise<Offer> {
    const offer = await Offer.findByPk(offerId, { lock: true, rejectOnEmpty: true, transaction });
    // The moment this transaction began: the instant every row it writes is stamped with.
    const now = await readDatabaseNow();
    const expired = offer.expiresAt <= now;
    if (expired) {
      throw new OfferExpiredError();
    }
    return offer.update({ clientId, claimedAt: now }, { transaction });
  }
}
```

- It reads `now()` inside the current transaction, on that transaction's own connection, and answers a `Date`.
- Inside a transaction `now()` stands still: every read, and every `databaseNow()` in it, is the moment the transaction began. Outside one, each read is a moment of its own.
- `readDatabaseNow({ transaction })` reads inside another transaction, and `readDatabaseNow({ connection })` on another connection: see [Options](#options).

## Log rollbacks

```ts
// app.module.ts
import { Logger, Module } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { useTransactionalConnection } from '@dakaio/sequelize-transactional';

@Module({})
export class AppModule {
  private readonly logger = new Logger(AppModule.name);

  constructor(@InjectConnection() sequelize: Sequelize) {
    useTransactionalConnection(sequelize, {
      onRollback: (error) => this.logger.error(error),
    });
  }
}
```

- `onRollback` is called with the error a decorated method threw, just before its transaction is rolled back: once per rolled-back transaction, by the outermost decorated method.
- It cannot stop the rollback or swallow the error. If it throws itself, the transaction is still rolled back, and the method rejects with the callback's error instead.
- A commit that fails is not reported here: its error reaches the caller as Sequelize throws it.

## Services that carry their own connection

Before registration existed, each service carried its connection and the decorator found it there. That still works while no connection is registered:

```ts
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import type { Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  databaseNow,
  Transactional,
  type TransactionalService,
} from '@dakaio/sequelize-transactional';

import { Report } from './report.model';

@Injectable()
export class ReportsService implements TransactionalService {
  constructor(@InjectConnection() public readonly sequelize: Sequelize) {}

  @Transactional()
  async archive(id: number, transaction?: Transaction): Promise<void> {
    await Report.update({ archivedAt: databaseNow() }, { where: { id }, transaction });
  }
}
```

The decorator takes the registered connection; failing that, the instance's `sequelize` field; failing that, the first of the instance's other own fields that holds a connection (TypeScript `private` fields count, ES `#private` ones are out of its reach). Once a connection is registered it wins over all of them, and `TransactionalService` is no longer needed.

## Options

`useTransactionalConnection(connection, options?)`:

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `connection` | `TransactionalConnection` | required | The app's Sequelize instance: anything with a `transaction()` method that opens one. |
| `options.onRollback` | `(error: unknown) => void` | none | Called with the error a decorated method threw, just before its transaction is rolled back. See [Log rollbacks](#log-rollbacks). |

`databaseNow(connection?)`:

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `connection` | `ClockConnection` | the registered connection | The connection to build `now()` with: anything with `fn()` and `query()`, a Sequelize instance among them. |

`readDatabaseNow(options?)`:

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `options.transaction` | `TransactionLike` | the transaction the caller runs inside; none outside one | The transaction to read inside. Inside one, `now()` is the moment it began. |
| `options.connection` | `ClockConnection` | the transaction's own connection, else the registered one | The connection to read on. |

## Errors

The package throws only for setup mistakes, as a `TransactionalError` whose `code` says which:

| `code` | Thrown by | When | What to do |
| --- | --- | --- | --- |
| `TRANSACTIONAL_ERROR.NO_CONNECTION` | a decorated method, as its rejection | No connection is registered, and the instance holds none | Call `useTransactionalConnection(sequelize)` at boot |
| `TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION` | `databaseNow()` (throws), `readDatabaseNow()` (rejects) | The connection it took (passed in, the transaction's own, or the registered one) is missing or cannot build `now()` and run a query | Register the connection, or pass one in |

Everything else passes through as it was thrown: a decorated method's own error after the rollback, and Sequelize's errors (a failed query, a commit Postgres refused) as Sequelize throws them.

```ts
import { TRANSACTIONAL_ERROR, TransactionalError } from '@dakaio/sequelize-transactional';

/** Whether the error is the package saying it was never given a connection. */
export const isUnregistered = (error: unknown): boolean =>
  error instanceof TransactionalError && error.code === TRANSACTIONAL_ERROR.NO_CONNECTION;
```

Compare the `code`, never the message: the message is written for a person, and may change. Its `name` is `TransactionalError`, and the `NO_CONNECTION` message names the method, as in `@Transactional on OrdersService.place has no connection`.

## How it works

- **Registration is module state.** `useTransactionalConnection()` keeps the connection in the package's module. A decorator runs where there is no DI container to ask, and asking would not help: a token built from the package's copy of a class finds nothing when the app's copy is a different object.
- **The decorator wraps the method.** `@Transactional()` replaces the method with a wrapper. On every call the wrapper asks [AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage) whether the call chain already runs inside a transaction. If it does, the wrapper calls the method with that transaction appended and leaves the ending to whoever opened it. If not, it opens a transaction on the registered connection, runs the method with the transaction appended inside `AsyncLocalStorage.run()`, and commits when the method returns. When it throws, the wrapper tells `onRollback`, rolls back and rethrows. A commit that fails is not followed by a rollback: it has already ended the transaction, as in Sequelize's own managed transactions.
- **`currentTransaction()` reads that AsyncLocalStorage.** It follows the call chain across `await`, timers and callbacks, and keeps concurrent chains apart.
- **The clock uses the app's own connection.** `databaseNow()` is `connection.fn('now')`, and `readDatabaseNow()` runs `SELECT now() AS now` on the transaction's connection, inside the transaction. Built from the package's own copy of Sequelize, a `fn('now')` would be an instance of a class the app's Sequelize has never seen, and would not be recognised as SQL.
- **Shapes, not classes.** A connection is recognised by its `transaction()` and `getQueryInterface()` methods, not by `instanceof Sequelize`. When the package is linked from a sibling folder, or simply not deduped, the app's `Sequelize` and one the package imported are two different class objects, and `instanceof` is false for a perfectly good connection, even at the same version. The clock, likewise, takes anything with `fn()` and `query()`.

## Caveats

### `readDatabaseNow()` is cut to the millisecond

Postgres keeps time to the microsecond, a JS `Date` to the millisecond. A row written with `databaseNow()` in the same millisecond as a later `readDatabaseNow()` holds a time a few microseconds after the value read back, so `WHERE placed_at <= :now` with that value misses it. Compare inside SQL with `databaseNow()` itself, or compare the two values in JS, where both are cut the same way.

### The transaction is appended, not put in its place

The decorator appends the transaction right after the arguments the caller passed, wherever that falls. A method with optional parameters before the transaction gets it in the wrong one when the caller leaves them out:

```ts
@Transactional()
async rename(id: number, item?: string, transaction?: Transaction): Promise<void> {
  await Order.update({ item }, { where: { id }, transaction });
}

await orders.rename(id); // `item` receives the transaction, and `transaction` is undefined
```

Keep the transaction the only optional parameter, have callers pass every parameter before it (`undefined` included), or read it with `currentTransaction()`. And never pass a transaction in yourself: the decorator's own lands after it.

### A query that is not handed the transaction runs outside it

It does not see the transaction's uncommitted rows, and its writes are not rolled back with them. Worse, if it touches a row the transaction has locked, it waits for the transaction, which waits for it: the very hang the package exists to prevent. Hand every query in a decorated method `{ transaction }`, from the last argument or from `currentTransaction()`.

### Catching an inner error does not undo it

Nested methods share one transaction, with no savepoints. When the outer method catches what an inner one threw and goes on, whatever the inner method wrote before it threw stays in the transaction and is committed with the rest.

And if the inner error came from a query that failed, Postgres has already aborted the whole transaction: every later query in it fails with "current transaction is aborted, commands ignored until end of transaction block", and the final commit quietly rolls back instead. The method returns as if everything was saved, and nothing is.

Let the error leave the outermost decorated method, and catch it in the caller.

### Work that outlives the method inherits its transaction

AsyncLocalStorage hands the transaction to everything the method starts, awaited or not. A promise it does not await, a timer, an event emitted to async listeners: each still sees the transaction after the method has committed it, and a decorated method called from there joins that finished transaction and fails. Start such work after the decorated method has returned.

### Put @Transactional() last, right above the method

`@Transactional()` replaces the method with a wrapper. Decorators apply from the bottom up, so one listed below it stores its metadata on the original method, which the wrapper then replaces, and the metadata is lost with it. Keep `@Transactional()` under the decorators that store metadata on the method, such as NestJS's `@Get()`, `@OnEvent()` and `@Cron()`:

```ts
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Transaction } from 'sequelize';
import { Transactional } from '@dakaio/sequelize-transactional';

import { Invoice, Order } from './models';

/** The events orders emit. */
export const ORDER_EVENT = {
  /** An order was placed. */
  PLACED: 'order.placed',
} as const;

@Injectable()
export class InvoicesService {
  @OnEvent(ORDER_EVENT.PLACED)
  @Transactional()
  async invoice(order: Order, transaction?: Transaction): Promise<void> {
    await Invoice.create({ orderId: order.id }, { transaction });
  }
}
```

### One connection

Every decorated method uses the registered connection, so an app with two databases cannot register both. The per-instance fallback picks each service's own connection, but only while nothing is registered.

## API reference

| Export | Kind | What it is |
| --- | --- | --- |
| `useTransactionalConnection(connection, options?)` | function | Registers the connection `@Transactional()` opens transactions on. [More](#register-the-connection) |
| `registeredTransactionalConnection()` | function | The registered connection, or `undefined` before one is registered |
| `Transactional()` | method decorator | Runs the method in a transaction, or in the caller's when there is one. [More](#decorate-a-method) |
| `currentTransaction<T>()` | function | The transaction the calling code runs inside, or `undefined`. [More](#reach-the-transaction-from-anywhere) |
| `databaseNow(connection?)` | function | `now()` as a SQL value for a query. [More](#databasenow-now-inside-the-query) |
| `readDatabaseNow(options?)` | function | `now()` read from the database, as a `Date`. [More](#readdatabasenow-now-read-into-the-app) |
| `TransactionalError` | class | A setup mistake; its `code` says which. [More](#errors) |
| `TRANSACTIONAL_ERROR` | constant and type | The codes: `NO_CONNECTION`, `NO_CLOCK_CONNECTION` |
| `TransactionalOptions` | interface | The options of `useTransactionalConnection()`: `onRollback` |
| `ReadDatabaseNowOptions` | interface | The options of `readDatabaseNow()`: `transaction`, `connection` |
| `TransactionLike` | interface | What the decorator needs from a transaction: `commit()`, `rollback()` |
| `TransactionalConnection` | interface | What the decorator needs from a connection: `transaction()` |
| `ClockConnection` | interface | What the clock needs from a connection: `fn()`, `query()` |
| `SqlFunction` | interface | A SQL function call, as `databaseNow()` answers it |
| `TransactionalService` | interface | A service that carries its own connection in a `sequelize` field. [More](#services-that-carry-their-own-connection) |

The signatures:

```ts
function useTransactionalConnection(
  connection: TransactionalConnection,
  options?: TransactionalOptions,
): void;
function registeredTransactionalConnection(): TransactionalConnection | undefined;
function Transactional(): MethodDecorator;
function currentTransaction<T = TransactionLike>(): T | undefined;
function databaseNow(connection?: ClockConnection): SqlFunction;
function readDatabaseNow(options?: ReadDatabaseNowOptions): Promise<Date>;

class TransactionalError extends Error {
  readonly code: TRANSACTIONAL_ERROR;
  constructor(code: TRANSACTIONAL_ERROR, where?: string);
}
```

Every export carries its documentation, with examples, into the editor.

## License

MIT
