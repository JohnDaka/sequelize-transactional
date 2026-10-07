import { AsyncLocalStorage } from 'node:async_hooks';

import { TRANSACTIONAL_ERROR, TransactionalError } from './errors.ts';
import { isFunction } from './guards.ts';

/**
 * What the decorator needs from a transaction: a shape rather than Sequelize's `Transaction`
 * class, so the app's own transaction fits it, whichever copy of Sequelize made it.
 */
export interface TransactionLike {
  /** Makes everything written in the transaction permanent, and ends it. */
  commit(): Promise<void>;
  /** Undoes everything written in the transaction, and ends it. */
  rollback(): Promise<void>;
}

/**
 * What the decorator needs from a connection: a way to open a transaction. A Sequelize instance
 * fits it, from `sequelize` or from `sequelize-typescript`.
 */
export interface TransactionalConnection {
  /**
   * Opens a transaction that the caller ends (Sequelize's unmanaged transaction): the decorator
   * commits it or rolls it back itself.
   */
  transaction(): Promise<TransactionLike>;
}

/** How {@link useTransactionalConnection} sets the decorator up, beyond the connection. */
export interface TransactionalOptions {
  /**
   * Called with the error a decorated method threw, just before its transaction is rolled back:
   * the place to log it. Only the outermost decorated method rolls back, so an error is reported
   * once, however deeply nested the method that threw it.
   *
   * It cannot stop the rollback, nor keep the error from reaching the caller. If it throws
   * itself, the transaction is still rolled back, and the method rejects with the callback's
   * error instead. A commit that fails is not reported here: its error reaches the caller as it
   * is.
   *
   * Default: none; the error only reaches the caller.
   */
  onRollback?: (error: unknown) => void;
}

/**
 * The connection every `@Transactional()` method opens its transaction on, set once at boot by
 * `useTransactionalConnection()`; undefined until then.
 *
 * Module state rather than something injected, because a decorator runs where there is no
 * container to ask, and asking would bring the linked-package problem straight back: the
 * package's `Sequelize` class is not the app's, so a DI token built from it finds nothing.
 */
let registeredConnection: TransactionalConnection | undefined;

/** The `onRollback` callback registered along with the connection; undefined when none was. */
let onRollback: TransactionalOptions['onRollback'];

/**
 * The transaction the current call chain runs inside, if any.
 *
 * AsyncLocalStorage carries it across every `await`, timer and callback in that chain, without
 * anything passing it on, and keeps concurrent requests apart: each call chain sees only the
 * transaction it opened.
 */
const activeTransaction = new AsyncLocalStorage<TransactionLike>();

/**
 * Tells `@Transactional()` which connection to open transactions on. Call it once, as early as
 * the app has its connection: in NestJS, the root module's constructor is the natural place.
 * After that no service needs a connection of its own for the decorator's sake.
 *
 * A second call replaces the first: the connection, and the options with it, so an option left
 * out is cleared.
 *
 * @param connection - The app's Sequelize instance: anything that can open a transaction.
 * @param options - See {@link TransactionalOptions}. Default: none.
 *
 * @example
 * ```ts
 * export class AppModule {
 *   constructor(@InjectConnection() sequelize: Sequelize) {
 *     useTransactionalConnection(sequelize, {
 *       onRollback: (error) => logger.error(error),
 *     });
 *   }
 * }
 * ```
 */
export const useTransactionalConnection = (
  connection: TransactionalConnection,
  options: TransactionalOptions = {},
): void => {
  registeredConnection = connection;
  onRollback = options.onRollback;
};

/**
 * The connection registered with {@link useTransactionalConnection}, for other helpers that work
 * on the app's connection: the database clock among them.
 *
 * @returns The registered connection, or undefined before one is registered.
 */
export const registeredTransactionalConnection = (): TransactionalConnection | undefined =>
  registeredConnection;

/**
 * The transaction the calling code runs inside, or undefined outside one.
 *
 * For code that a `@Transactional()` method calls but that is not a decorated method itself (a
 * helper several services share, a model hook), which would otherwise need the transaction
 * threaded through every signature to reach it. A query takes part only when it is handed the
 * transaction, from here or from the method's last argument.
 *
 * @typeParam T - The type to see the transaction as: the app's own, Sequelize's `Transaction`.
 *   Default: {@link TransactionLike}.
 * @returns The transaction, or undefined outside one.
 *
 * @example
 * ```ts
 * // A helper the decorated methods share, with no transaction parameter of its own:
 * const reserve = (item: Item, quantity: number): Promise<Item> =>
 *   item.decrement({ stock: quantity }, { transaction: currentTransaction<Transaction>() });
 * ```
 */
export const currentTransaction = <T = TransactionLike>(): T | undefined =>
  activeTransaction.getStore() as T | undefined;

/**
 * Contract for a service that still carries its own connection, from before
 * `useTransactionalConnection()`: the decorator falls back to its `sequelize` field while no
 * connection is registered.
 *
 * No longer needed once the app registers its connection: kept so services written against it
 * keep compiling and keep working unchanged.
 */
export interface TransactionalService {
  /** The connection the service's decorated methods use while none is registered. */
  readonly sequelize: TransactionalConnection;
}

/** The two methods a Sequelize instance is recognised by. */
interface ConnectionShape {
  /** Opens a transaction: what the decorator needs. */
  transaction?: unknown;
  /**
   * Answers Sequelize's query interface: what tells a Sequelize instance apart from anything
   * else that happens to have a `transaction` method.
   */
  getQueryInterface?: unknown;
}

/**
 * Whether the value is a connection the decorator can use. Deliberately a shape check, not
 * `instanceof Sequelize`.
 *
 * `sequelize-typescript` is the app's own dependency, and when this package is linked from a
 * sibling folder (or simply not deduped) there are two copies of it: the class object here and
 * the class the app constructed its connection from are two different objects, and `instanceof`
 * returns false for a perfectly good connection, even at the same version. A library cannot
 * assume it shares a class identity with its consumer.
 */
const isConnectionLike = (value: unknown): value is TransactionalConnection => {
  const candidate = value as ConnectionShape | null | undefined;
  return (
    !!candidate && isFunction(candidate.transaction) && isFunction(candidate.getQueryInterface)
  );
};

/**
 * The connection a decorated method opens its transaction on: the registered one; failing that,
 * one the instance carries, the older way, kept so an app that has not registered yet keeps
 * working. The `sequelize` field is looked at first, then every other field of the instance's own
 * (an ES `#private` field is out of reach).
 *
 * Looked up on every call rather than once at decoration: classes are decorated when their module
 * loads, before the app has registered anything.
 *
 * @throws {TransactionalError} {@link TRANSACTIONAL_ERROR.NO_CONNECTION} when there is neither.
 */
const connectionFor = (instance: object, method: string | symbol): TransactionalConnection => {
  if (registeredConnection) {
    return registeredConnection;
  }

  const { sequelize } = instance as { sequelize?: unknown };
  if (isConnectionLike(sequelize)) {
    return sequelize;
  }

  const carried = Object.values(instance).find(isConnectionLike);
  if (carried) {
    return carried;
  }

  throw new TransactionalError(
    TRANSACTIONAL_ERROR.NO_CONNECTION,
    `${instance.constructor.name}.${String(method)}`,
  );
};

/** A decorated method as the decorator calls it: whatever it takes, the transaction last. */
type DecoratedMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

/**
 * Runs the method in a transaction: commits when it returns, rolls back when it throws.
 *
 * The transaction is appended as the method's **last argument**, right after the arguments the
 * caller passed: the method declares it as its last parameter, and callers leave it out. A query
 * takes part by being handed it. A query that is not handed it runs outside: it does not see the
 * transaction's uncommitted rows, and its writes do not roll back with them. Code that is not a
 * decorated method reaches the transaction through {@link currentTransaction}.
 *
 * **Nesting joins.** A decorated method called from inside another one's transaction runs in
 * that same transaction: it receives it as its last argument, and it neither commits nor rolls
 * back; the outermost method does. An error from the inner method reaches the outer one and
 * rolls the whole transaction back, unless the outer one catches it. Then the outer method goes
 * on in the same transaction, with what the inner one wrote still in it, and if a query failed,
 * Postgres has aborted the transaction: every later query in it fails, and the final commit
 * quietly rolls back instead.
 *
 * The decorated method always returns a promise, so decorate methods that are async already.
 *
 * @returns The method decorator: it needs `experimentalDecorators`, which NestJS and
 *   `sequelize-typescript` projects have on.
 * @throws {TransactionalError} {@link TRANSACTIONAL_ERROR.NO_CONNECTION}, as the decorated
 *   method's rejection, when there is no connection to open the transaction on.
 *
 * @example
 * ```ts
 * class OrdersService {
 *   \@Transactional()
 *   async place(order: NewOrder, transaction?: Transaction): Promise<Order> {
 *     await this.stock.reserve(order.items); // decorated too: joins this transaction
 *     return Order.create(order, { transaction });
 *   }
 * }
 * ```
 */
export const Transactional =
  (): MethodDecorator =>
  (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value as DecoratedMethod;

    const decorated: DecoratedMethod = async function (this: object, ...args: unknown[]) {
      // Called from inside another decorated method: join its transaction, leave the ending to it.
      const outer = activeTransaction.getStore();
      if (outer) {
        return originalMethod.apply(this, [...args, outer]);
      }

      const transaction = await connectionFor(this, propertyKey).transaction();

      let result: unknown;
      try {
        result = await activeTransaction.run(transaction, () =>
          originalMethod.apply(this, [...args, transaction]),
        );
      } catch (error) {
        try {
          onRollback?.(error);
        } finally {
          // Even when the callback throws: an open transaction keeps its connection and its locks.
          await transaction.rollback();
        }
        throw error;
      }

      // Outside the try, as in Sequelize's own managed transactions: a commit that fails has
      // already ended the transaction, so a rollback after it would only fail too, and its error
      // would hide the one that says why the commit failed.
      await transaction.commit();
      return result;
    };
    descriptor.value = decorated;

    return descriptor;
  };
