import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  DataTypes,
  Deferrable,
  ForeignKeyConstraintError,
  Op,
  type Model,
  type ModelStatic,
  type Transaction,
} from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

import { databaseNow, readDatabaseNow } from './database-clock.ts';
import { decorate, forgetConnection } from './testing/fakes.ts';
import { currentTransaction, useTransactionalConnection } from './transactional.ts';

/**
 * The same package against a real Postgres, through the app's own `sequelize-typescript`
 * connection: what the fakes cannot show, such as rows a query sees, locks and the database clock.
 *
 * Runs when DB_HOST is set (with DB_PORT, DB_USERNAME and DB_PASSWORD as needed) and is skipped
 * otherwise. It creates its own database, and drops it when done.
 */

/** Postgres's own port, when DB_PORT is not set. */
const POSTGRES_PORT = 5432;

/** The server to run against. */
const SERVER = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? POSTGRES_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
};

/** Why the spec does not run, when it does not. */
const SKIP = !SERVER.host && 'set DB_HOST (DB_PORT, DB_USERNAME, DB_PASSWORD) to run it';

/** The database the spec creates for itself, and drops once it is done. */
const DATABASE = 'dakaio_transactional_test';

/** The database every Postgres has, to create and drop the spec's own from. */
const MAINTENANCE_DATABASE = 'postgres';

/**
 * How long a query waits for a lock before it fails, in milliseconds: a method that waits on a
 * lock its own transaction holds fails fast instead of hanging the run.
 */
const LOCK_TIMEOUT_MS = 2000;

/** Long enough for a clock to move between two reads, in milliseconds. */
const CLOCK_TICK_MS = 20;

/** An hour, in milliseconds. */
const HOUR_MS = 60 * 60 * 1000;

/** Postgres's code (SQLSTATE) for a query sent in a transaction it has already aborted. */
const IN_FAILED_SQL_TRANSACTION = '25P02';

/** What the failing methods throw. */
const NO_STOCK = 'no stock';

/** A customer id no row has: an invoice for it breaks its deferred foreign key at commit. */
const NOBODY = 1;

/** The connection under test and its models, made once the database exists. */
let sequelize: Sequelize;
let Order: ModelStatic<Model>;
let Customer: ModelStatic<Model>;
/** Its customer is checked at commit (a deferred foreign key), not when the row is written. */
let Invoice: ModelStatic<Model>;

/** How many orders there are, as a query outside every transaction sees them. */
const committedOrders = (): Promise<number> => Order.count();

/** A helper that is not a decorated method: it reaches the transaction on its own. */
const countInCurrentTransaction = (): Promise<number> =>
  Order.count({ transaction: currentTransaction<Transaction>() });

/** A service as an app writes one; its methods are decorated below. */
class Orders {
  public async place(item: string, transaction?: Transaction): Promise<Model> {
    return Order.create({ item }, { transaction });
  }

  public async placeAndFail(item: string, transaction?: Transaction): Promise<never> {
    await Order.create({ item }, { transaction });
    throw new Error(NO_STOCK);
  }

  /** Counts as the transaction sees it, as a query not handed it sees it, and from a helper. */
  public async placeAndCount(item: string, transaction?: Transaction): Promise<number[]> {
    await Order.create({ item }, { transaction });
    return [
      await Order.count({ transaction }),
      await committedOrders(),
      await countInCurrentTransaction(),
    ];
  }

  /** Places one order itself and one through a nested decorated method. */
  public async placeTwo(first: string, second: string, transaction?: Transaction): Promise<void> {
    await Order.create({ item: first }, { transaction });
    await this.place(second);
  }

  public async rename(id: number, item: string, transaction?: Transaction): Promise<void> {
    await Order.update({ item }, { where: { id }, transaction });
  }

  /** Locks the row by writing it, then writes it again through a nested decorated method. */
  public async renameTwice(id: number, first: string, second: string, transaction?: Transaction) {
    await Order.update({ item: first }, { where: { id }, transaction });
    await this.rename(id, second);
  }

  /** Catches what a nested method threw, then places one more. */
  public async placeDespiteFailure(transaction?: Transaction): Promise<void> {
    await this.placeAndFail('tea').catch(() => undefined);
    await Order.create({ item: 'cake' }, { transaction });
  }

  /** Catches a nested method's failed query, then goes on querying. */
  public async placeAfterFailedQuery(item: string, transaction?: Transaction): Promise<void> {
    await Order.create({ item }, { transaction });
    await this.place(item).catch(() => undefined);
    await Order.create({ item: 'cake' }, { transaction });
  }

  /** Catches a nested method's failed query, then returns as if all went well. */
  public async placeDespiteFailedQuery(item: string, transaction?: Transaction): Promise<void> {
    await Order.create({ item }, { transaction });
    await this.place(item).catch(() => undefined);
  }

  /** The stamp `databaseNow()` writes, and what `readDatabaseNow()` reads, a moment apart. */
  public async stamp(item: string, transaction?: Transaction): Promise<Date[]> {
    const order = await Order.create({ item }, { transaction });
    await sleep(CLOCK_TICK_MS);
    await Order.update(
      { placedAt: databaseNow() },
      { where: { id: order.get('id') }, transaction },
    );
    await order.reload({ transaction });
    return [order.get('placedAt') as Date, await readDatabaseNow()];
  }

  /** Reads the clock twice, a moment apart, inside one transaction. */
  public async readTwice(_transaction?: Transaction): Promise<Date[]> {
    const first = await readDatabaseNow();
    await sleep(CLOCK_TICK_MS);
    return [first, await readDatabaseNow()];
  }
}
decorate(
  Orders.prototype,
  'place',
  'placeAndFail',
  'placeAndCount',
  'placeTwo',
  'rename',
  'renameTwice',
  'placeDespiteFailure',
  'placeAfterFailedQuery',
  'placeDespiteFailedQuery',
  'stamp',
  'readTwice',
);

/** Writes an invoice Postgres accepts now and refuses at commit. */
class Billing {
  public async invoiceNobody(transaction?: Transaction): Promise<void> {
    await Invoice.create({ customerId: NOBODY }, { transaction });
  }
}
decorate(Billing.prototype, 'invoiceNobody');

describe('against Postgres', { skip: SKIP }, () => {
  let admin: Sequelize | undefined;
  const orders = new Orders();

  before(async () => {
    admin = new Sequelize({
      dialect: 'postgres',
      ...SERVER,
      database: MAINTENANCE_DATABASE,
      logging: false,
    });
    await admin.getQueryInterface().dropDatabase(DATABASE);
    await admin.getQueryInterface().createDatabase(DATABASE);

    sequelize = new Sequelize({
      dialect: 'postgres',
      ...SERVER,
      database: DATABASE,
      logging: false,
      dialectOptions: { lock_timeout: LOCK_TIMEOUT_MS },
    });
    Order = sequelize.define(
      'Order',
      {
        item: { type: DataTypes.TEXT, allowNull: false, unique: true },
        placedAt: { type: DataTypes.DATE },
      },
      { underscored: true },
    );
    Customer = sequelize.define('Customer', {}, { underscored: true });
    Invoice = sequelize.define(
      'Invoice',
      {
        customerId: {
          type: DataTypes.INTEGER,
          references: {
            model: Customer,
            key: 'id',
            deferrable: new Deferrable.INITIALLY_DEFERRED(),
          },
        },
      },
      { underscored: true },
    );
    await sequelize.sync();
  });

  beforeEach(async () => {
    useTransactionalConnection(sequelize);
    await sequelize.truncate({ cascade: true, restartIdentity: true });
  });

  after(async () => {
    await sequelize?.close();
    await admin?.getQueryInterface().dropDatabase(DATABASE);
    await admin?.close();
  });

  describe('@Transactional', () => {
    it('commits what the method wrote', async () => {
      await orders.place('tea');

      assert.equal(await committedOrders(), 1);
    });

    it('rolls back what the method wrote when it throws', async () => {
      await assert.rejects(orders.placeAndFail('tea'), { message: NO_STOCK });

      assert.equal(await committedOrders(), 0);
    });

    it('shows its uncommitted rows only to queries handed the transaction', async () => {
      const [inside, outside, fromHelper] = await orders.placeAndCount('tea');

      assert.deepEqual({ inside, outside, fromHelper }, { inside: 1, outside: 0, fromHelper: 1 });
      assert.equal(await committedOrders(), 1);
    });

    it('runs a nested method in the same transaction, committed together', async () => {
      await orders.placeTwo('tea', 'cake');

      assert.equal(await committedOrders(), 2);
    });

    it('rolls a nested method back with the outer one', async () => {
      class Checkout {
        public async placeTwoAndFail(transaction?: Transaction): Promise<void> {
          await orders.placeTwo('tea', 'cake');
          await Order.create({ item: 'pie' }, { transaction });
          throw new Error(NO_STOCK);
        }
      }
      decorate(Checkout.prototype, 'placeTwoAndFail');

      await assert.rejects(new Checkout().placeTwoAndFail(), { message: NO_STOCK });

      assert.equal(await committedOrders(), 0);
    });

    it('lets a nested method write a row the outer one locked, without waiting', async () => {
      const id = (await orders.place('tea')).get('id') as number;

      await orders.renameTwice(id, 'cake', 'pie');

      const [order] = await Order.findAll();
      assert.equal(order.get('item'), 'pie');
    });

    it("commits a failed nested method's writes when the outer one catches its error", async () => {
      await orders.placeDespiteFailure();

      const items = (await Order.findAll({ order: [['item', 'ASC']] })).map((order) =>
        order.get('item'),
      );
      assert.deepEqual(items, ['cake', 'tea']);
    });

    it('fails every later query once a nested query has failed and was caught', async () => {
      await assert.rejects(orders.placeAfterFailedQuery('tea'), (error) => {
        const { parent } = error as { parent?: { code?: string } };
        assert.equal(parent?.code, IN_FAILED_SQL_TRANSACTION);
        return true;
      });

      assert.equal(await committedOrders(), 0);
    });

    it('rolls back on commit, quietly, once a nested query has failed and was caught', async () => {
      await orders.placeDespiteFailedQuery('tea');

      assert.equal(await committedOrders(), 0);
    });

    it('rejects with the reason Postgres refused the commit', async (t) => {
      // Sequelize warns as it drops the connection a failed commit leaves behind.
      t.mock.method(console, 'warn', () => undefined);

      await assert.rejects(new Billing().invoiceNobody(), ForeignKeyConstraintError);

      assert.equal(await Invoice.count(), 0);
    });
  });

  describe('the database clock', () => {
    it('stamps a row with the moment its transaction began, as readDatabaseNow() reads it', async () => {
      const [stamped, read] = await orders.stamp('tea');

      assert.ok(stamped instanceof Date);
      assert.equal(stamped.getTime(), read.getTime());
    });

    it('stands still inside a transaction', async () => {
      const [first, second] = await orders.readTwice();

      assert.equal(first.getTime(), second.getTime());
    });

    it('moves outside one', async () => {
      const first = await readDatabaseNow();
      await sleep(CLOCK_TICK_MS);
      const second = await readDatabaseNow();

      assert.ok(second > first);
    });

    it('compares in a where, without reading it first', async () => {
      const now = await readDatabaseNow();
      await Order.bulkCreate([
        { item: 'due', placedAt: new Date(now.getTime() - HOUR_MS) },
        { item: 'later', placedAt: new Date(now.getTime() + HOUR_MS) },
      ]);

      const due = await Order.findAll({ where: { placedAt: { [Op.lte]: databaseNow() } } });

      assert.deepEqual(
        due.map((order) => order.get('item')),
        ['due'],
      );
    });

    it("takes the app's Sequelize instance as the connection to ask", async () => {
      forgetConnection();
      await Order.create({ item: 'tea' });

      await Order.update({ placedAt: databaseNow(sequelize) }, { where: { item: 'tea' } });
      const now = await readDatabaseNow({ connection: sequelize });

      // Both read into JS, both cut to the millisecond: Postgres keeps microseconds, so comparing
      // the column with `now` in SQL could miss a row written in the same millisecond.
      const order = await Order.findOne({ where: { item: 'tea' } });
      const placedAt = order?.get('placedAt') as Date;
      assert.ok(placedAt instanceof Date);
      assert.ok(placedAt.getTime() <= now.getTime());
    });

    it("reads on a transaction's own connection when none is registered", async () => {
      forgetConnection();
      const transaction = await sequelize.transaction();

      try {
        assert.ok((await readDatabaseNow({ transaction })) instanceof Date);
      } finally {
        await transaction.rollback();
      }
    });
  });
});
