/**
 * Fakes the unit specs share: a connection and its transactions that log what happens to them,
 * and the decorator applied by hand. Not published (tsconfig.build.json leaves this folder out).
 */
import {
  Transactional,
  useTransactionalConnection,
  type TransactionLike,
} from '../transactional.ts';

/** What a fake connection logs, in the order it happens. */
export const EVENT = {
  /** A transaction was committed. */
  COMMIT: 'commit',
  /** A transaction was rolled back. */
  ROLLBACK: 'rollback',
  /** The `onRollback` callback was called: the spec that registers it logs this. */
  ON_ROLLBACK: 'onRollback',
} as const;
/** One of the {@link EVENT}s. */
export type EVENT = (typeof EVENT)[keyof typeof EVENT];

/** The instant a fake connection's `now()` answers unless told otherwise. */
export const FAKE_NOW = new Date('2026-10-07T10:00:00Z');

/** A query a fake connection was asked to run, with the options it was given. */
export interface FakeQuery {
  /** The SQL, as the clock wrote it. */
  sql: string;
  /** The options, as the clock passed them. */
  options: { type: string; plain: boolean; transaction?: TransactionLike | null };
}

/** A SQL function call as a fake connection builds one: what it calls, and who built it. */
export interface FakeFn {
  /** The SQL function. */
  name: string;
  /** Its arguments. */
  args: unknown[];
  /** The connection that built it. */
  builtBy: FakeConnection;
  /** Answers itself: nothing to copy. */
  clone(): FakeFn;
}

/** How a fake connection behaves. */
export interface FakeConnectionOptions {
  /** What `now()` answers. Default: {@link FAKE_NOW}. */
  now?: Date;
  /** The error every commit fails with, as when Postgres refuses one. Default: none. */
  commitError?: Error;
}

/**
 * A transaction that remembers how it ended and logs it on its connection. Like Sequelize's, it
 * is finished once a commit has been tried, failed or not, and refuses to end a second time.
 */
export class FakeTransaction implements TransactionLike {
  /** How it ended; undefined while it is open. */
  public ended: EVENT | undefined;
  /** The connection it was opened on, where Sequelize keeps it too; none if made by hand. */
  public readonly sequelize: FakeConnection | undefined;

  public constructor(sequelize?: FakeConnection) {
    this.sequelize = sequelize;
  }

  /** Ends it as committed, then fails if the connection's commits do. */
  public async commit(): Promise<void> {
    this.end(EVENT.COMMIT);
    const failure = this.sequelize?.commitError;
    if (failure) {
      throw failure;
    }
  }

  /** Ends it as rolled back. */
  public async rollback(): Promise<void> {
    this.end(EVENT.ROLLBACK);
  }

  /** Ends it once, logging how; a second end throws, as Sequelize's does. */
  private end(how: EVENT): void {
    if (this.ended) {
      throw new Error(`The transaction has been finished with state: ${this.ended}`);
    }
    this.ended = how;
    this.sequelize?.events.push(how);
  }
}

/** Just enough of a Sequelize instance: transactions, `fn`, `query`, and a log of each. */
export class FakeConnection {
  /** Every transaction opened on it, in order. */
  public readonly opened: FakeTransaction[] = [];
  /** Every query it ran, in order. */
  public readonly queries: FakeQuery[] = [];
  /** How its transactions ended, and when `onRollback` was called, in order. */
  public readonly events: EVENT[] = [];
  /** What its commits fail with, if they do. */
  public readonly commitError: Error | undefined;
  /** What its `now()` answers. */
  private readonly now: Date;

  public constructor({ now = FAKE_NOW, commitError }: FakeConnectionOptions = {}) {
    this.now = now;
    this.commitError = commitError;
  }

  /** What the decorator recognises a Sequelize instance by, with `transaction`. */
  public getQueryInterface(): object {
    return {};
  }

  /** Opens a transaction and remembers it. */
  public async transaction(): Promise<FakeTransaction> {
    const transaction = new FakeTransaction(this);
    this.opened.push(transaction);
    return transaction;
  }

  /** Builds a SQL function call that remembers what it calls and who built it. */
  public fn(name: string, ...args: unknown[]): FakeFn {
    return {
      name,
      args,
      builtBy: this,
      clone() {
        return this;
      },
    };
  }

  /** Remembers the query, and answers the row the clock reads. */
  public async query(sql: string, options: FakeQuery['options']): Promise<{ now: Date }> {
    this.queries.push({ sql, options });
    return { now: this.now };
  }
}

/**
 * Applies `@Transactional()` to methods the way the TypeScript compiler does: Node runs the
 * specs with its type stripping, which has no decorator syntax.
 */
export const decorate = (target: object, ...methods: string[]): void => {
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method)!;
    const decorated = Transactional()(target, method, descriptor) ?? descriptor;
    Object.defineProperty(target, method, decorated);
  }
};

/** Leaves the package with no registered connection: it has no way to unregister one. */
export const forgetConnection = (): void => {
  useTransactionalConnection(undefined as never);
};
