/**
 * The codes of a {@link TransactionalError}: which setup mistake it is, by what is missing.
 *
 * Compare an error's `code` against these rather than its message: the message is written for a
 * person, and may change.
 */
export const TRANSACTIONAL_ERROR = {
  /**
   * `@Transactional()` found no connection to open a transaction on: none was registered with
   * `useTransactionalConnection()`, and none of the instance's own fields holds one.
   */
  NO_CONNECTION: 'NO_CONNECTION',
  /**
   * The database clock found no connection it can ask: the one it took (passed in, else the
   * transaction's own, else the registered one) is missing, or cannot build a SQL function and
   * run a query.
   */
  NO_CLOCK_CONNECTION: 'NO_CLOCK_CONNECTION',
} as const;

/** One of the {@link TRANSACTIONAL_ERROR} codes: the type of `TransactionalError.code`. */
export type TRANSACTIONAL_ERROR = (typeof TRANSACTIONAL_ERROR)[keyof typeof TRANSACTIONAL_ERROR];

/**
 * What each mistake says, given where it happened. Without these the missing connection
 * surfaces as "Cannot read properties of undefined (reading 'transaction')", which points
 * nowhere near the actual mistake.
 */
const MESSAGE: Record<TRANSACTIONAL_ERROR, (where: string) => string> = {
  [TRANSACTIONAL_ERROR.NO_CONNECTION]: (where) =>
    `@Transactional on ${where} has no connection. ` +
    'Call useTransactionalConnection(sequelize) once at boot.',
  [TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION]: () =>
    "The database clock needs a connection: register the app's with " +
    'useTransactionalConnection(), or pass one in.',
};

/**
 * A setup mistake, its `code` telling which, so it is never mistaken for the app's own error.
 *
 * The package throws it only when the app has not given it what it needs. An error a decorated
 * method throws itself passes through unchanged, after the rollback.
 *
 * @example
 * ```ts
 * // Whatever the package throws is a setup mistake, not a request that failed:
 * const isSetupMistake = (error: unknown): boolean => error instanceof TransactionalError;
 *
 * // One mistake in particular, by its code:
 * const isUnregistered = (error: unknown): boolean =>
 *   error instanceof TransactionalError && error.code === TRANSACTIONAL_ERROR.NO_CONNECTION;
 * ```
 */
export class TransactionalError extends Error {
  /** Which mistake this is: one of {@link TRANSACTIONAL_ERROR}. */
  public readonly code: TRANSACTIONAL_ERROR;

  /**
   * @param code - Which mistake it is; it picks the message.
   * @param where - Where it happened, named in the message: the decorated method, as
   *   `Class.method`. Empty by default, for a mistake that has no such place.
   */
  public constructor(code: TRANSACTIONAL_ERROR, where = '') {
    super(MESSAGE[code](where));
    // The class's own name rather than Error's: what a stack trace and a logger print first.
    this.name = TransactionalError.name;
    this.code = code;
  }
}
