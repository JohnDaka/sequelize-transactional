/**
 * The database clock: "now", as the database's clock says it, for every timestamp that is part of
 * a claim or decides something.
 *
 * Several app servers are several clocks, each a little off, any of them drifted or set up
 * wrong. The database is one clock for all of them, and the one the rows are written against.
 * Taken from it, "is this due?" gives the same answer wherever it is asked, and a timestamp one
 * instance wrote compares cleanly with one another instance wrote. Store such columns as
 * `timestamptz`: an absolute instant, whatever zone anything runs in.
 *
 * Built from the app's own connection, never from a Sequelize this package imports. A linked
 * package has its own copy of Sequelize, and a `fn('now')` made from that copy is an instance of
 * a class the app's Sequelize has never seen: it would not be recognised as SQL at all.
 */
import { TRANSACTIONAL_ERROR, TransactionalError } from './errors.ts';
import { isFunction } from './guards.ts';
import {
  currentTransaction,
  registeredTransactionalConnection,
  type TransactionLike,
} from './transactional.ts';

/**
 * The SQL function that answers the current instant: Postgres's `now()`, which inside a
 * transaction is the moment that transaction began.
 */
const NOW = 'now';

/** Reads that instant in one row, under the column name the result is read from. */
const READ_NOW = `SELECT ${NOW}() AS ${NOW}`;

/**
 * Sequelize's query types, by the values its `QueryTypes` holds. Named here rather than read off
 * the connection: Sequelize's typings leave `QueryTypes` off the instance, so requiring it would
 * turn away the very connection the app passes in.
 */
const QUERY_TYPE = {
  /** A query that reads rows: Sequelize answers them as plain objects. */
  SELECT: 'SELECT',
} as const;

/** The row `READ_NOW` answers. */
interface NowRow {
  /** The instant, as the driver reads a `timestamptz` into a Date. */
  [NOW]: Date;
}

/**
 * A SQL function call as Sequelize represents one (its `Fn`): put into a query as a value, it is
 * written out as the call itself, and the database works it out.
 *
 * A shape that copies Sequelize's own typing of `Fn` member for member, so the app's TypeScript
 * accepts {@link databaseNow} wherever it accepts a `fn()`.
 */
export interface SqlFunction {
  /** Copies the call, as Sequelize's `Fn` does. */
  clone(): this;
}

/**
 * What the clock needs from a connection: two of the Sequelize instance's own helpers. A
 * Sequelize instance fits it, from `sequelize` or from `sequelize-typescript`.
 */
export interface ClockConnection {
  /**
   * Builds a SQL function call to put into a query as a value: the instance's `fn()`.
   *
   * @param name - The SQL function.
   * @param args - Its arguments.
   */
  fn(name: string, ...args: unknown[]): SqlFunction;
  /**
   * Runs a query and answers its result: the instance's `query()`, which reads `now()` into the
   * app.
   *
   * @param sql - The query.
   * @param options - How to run it and read its result.
   */
  query(
    sql: string,
    options: {
      /** What kind of query it is, which decides how its result is read: rows, for the clock. */
      type: string;
      /** Whether to answer the first row alone rather than a list: yes, for the clock. */
      plain: boolean;
      /** The transaction to run inside. Left out or null (as Sequelize allows): outside any. */
      transaction?: TransactionLike | null;
    },
  ): Promise<unknown>;
}

/** Where `readDatabaseNow()` reads the instant: inside which transaction, on which connection. */
export interface ReadDatabaseNowOptions {
  /**
   * The transaction to read inside. Inside one, `now()` is the moment it began: the same instant
   * every row it writes with `databaseNow()` carries.
   *
   * Default: the one the caller runs inside under `@Transactional()`; outside one, none, and
   * `now()` is the moment of the read itself.
   */
  transaction?: TransactionLike;
  /**
   * The connection to read on.
   *
   * Default: the transaction's own (the connection it was opened on), else the one registered
   * with `useTransactionalConnection()`.
   */
  connection?: ClockConnection;
}

/**
 * Whether the value can serve the clock: it builds SQL functions and runs queries. A shape check,
 * for the same reason as the decorator's: the app's Sequelize class is not one this package can
 * compare against.
 */
const isClockConnection = (value: unknown): value is ClockConnection => {
  const candidate = value as Partial<ClockConnection> | null | undefined;
  return !!candidate && isFunction(candidate.fn) && isFunction(candidate.query);
};

/**
 * The connection the clock asks: the one passed in, else the transaction's own, else the
 * registered one. The first of those that is there is the one used: if it cannot serve the
 * clock, it is refused rather than passed over for the next.
 *
 * @throws {TransactionalError} {@link TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION} when that
 *   connection is missing or cannot serve the clock.
 */
const connectionFor = (
  explicit?: ClockConnection,
  transaction?: TransactionLike,
): ClockConnection => {
  const candidate =
    explicit ??
    // Sequelize's transactions carry their connection, though its typings do not say so.
    (transaction as { sequelize?: unknown } | undefined)?.sequelize ??
    registeredTransactionalConnection();

  if (!isClockConnection(candidate)) {
    throw new TransactionalError(TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION);
  }

  return candidate;
};

/**
 * `now()` as a value in a query: written into the SQL, so the database's clock decides the
 * instant, with no round trip to read it first. Run inside a transaction, it is the moment that
 * transaction began, the same for every row it writes.
 *
 * Some Sequelize typings (`create`, `bulkCreate`, `upsert`) do not accept a SQL function as a
 * value: read the instant with {@link readDatabaseNow} for those.
 *
 * @param connection - The connection to build it from. Default: the one registered with
 *   `useTransactionalConnection()`.
 * @returns The SQL function call, for a `where` or the values of an `update`.
 * @throws {TransactionalError} {@link TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION} when there is no
 *   connection to build it from.
 *
 * @example
 * ```ts
 * // Every reminder that is due, by the database's clock:
 * const due = await Reminder.findAll({ where: { sendAt: { [Op.lte]: databaseNow() } } });
 *
 * // Stamped by the database's clock, without reading it first:
 * await Booking.update({ cancelledAt: databaseNow() }, { where: { id }, transaction });
 * ```
 */
export const databaseNow = (connection?: ClockConnection): SqlFunction =>
  connectionFor(connection).fn(NOW);

/**
 * The database's `now()` read into the application, for when the value itself is needed:
 * returned to a caller, put into an event, compared in code, or written where a SQL function is
 * not accepted.
 *
 * @param options - Which transaction to read inside, on which connection: see
 *   {@link ReadDatabaseNowOptions}. Default: the current transaction, on its own connection.
 * @returns The instant, as a Date.
 * @throws {TransactionalError} {@link TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION}, as the
 *   rejection, when there is no connection to read on.
 *
 * @example
 * ```ts
 * // Inside a decorated method: the moment its transaction began.
 * const now = await readDatabaseNow();
 * const expired = offer.expiresAt <= now;
 *
 * // Anywhere else, inside a transaction of the caller's choosing:
 * const startedAt = await readDatabaseNow({ transaction });
 * ```
 */
export const readDatabaseNow = async ({
  transaction = currentTransaction(),
  connection,
}: ReadDatabaseNowOptions = {}): Promise<Date> => {
  const sequelize = connectionFor(connection, transaction);

  const row = (await sequelize.query(READ_NOW, {
    type: QUERY_TYPE.SELECT,
    plain: true,
    transaction,
  })) as NowRow;

  return row[NOW];
};
