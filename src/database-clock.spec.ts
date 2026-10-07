import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { databaseNow, readDatabaseNow } from './database-clock.ts';
import { TRANSACTIONAL_ERROR, TransactionalError } from './errors.ts';
import {
  decorate,
  FAKE_NOW,
  FakeConnection,
  FakeTransaction,
  forgetConnection,
  type FakeFn,
} from './testing/fakes.ts';
import { useTransactionalConnection, type TransactionLike } from './transactional.ts';

/** What the clock refuses with when it has no connection it can ask. */
const NO_CLOCK_CONNECTION = {
  name: TransactionalError.name,
  code: TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION,
};

/** A connection the decorator can use but the clock cannot: it has no `fn` and no `query`. */
const transactionsOnly = () => ({
  getQueryInterface: () => ({}),
  transaction: async () => new FakeTransaction(),
});

/** Reads the clock from inside a decorated method, with no transaction of its own passed. */
class Clock {
  public async read(_transaction?: TransactionLike): Promise<Date> {
    return readDatabaseNow();
  }

  public async readInside(other: TransactionLike, _transaction?: TransactionLike): Promise<Date> {
    return readDatabaseNow({ transaction: other });
  }
}
decorate(Clock.prototype, 'read', 'readInside');

describe('databaseNow', () => {
  beforeEach(forgetConnection);

  it("builds now() from the registered connection's fn", () => {
    const connection = new FakeConnection();
    useTransactionalConnection(connection);

    const now = databaseNow() as unknown as FakeFn;

    assert.deepEqual([now.name, now.args, now.builtBy], ['now', [], connection]);
  });

  it('builds it from the connection passed in, over the registered one', () => {
    const passed = new FakeConnection();
    useTransactionalConnection(new FakeConnection());

    const now = databaseNow(passed) as unknown as FakeFn;

    assert.equal(now.builtBy, passed);
  });

  it('runs no query', () => {
    const connection = new FakeConnection();

    databaseNow(connection);

    assert.deepEqual(connection.queries, []);
  });

  it('refuses when no connection is registered or passed in', () => {
    assert.throws(() => databaseNow(), NO_CLOCK_CONNECTION);
  });

  it('refuses a registered connection that cannot build SQL functions', () => {
    useTransactionalConnection(transactionsOnly());

    assert.throws(() => databaseNow(), NO_CLOCK_CONNECTION);
  });

  it('refuses a connection passed in that cannot serve, rather than fall back', () => {
    useTransactionalConnection(new FakeConnection());

    assert.throws(() => databaseNow(transactionsOnly() as never), NO_CLOCK_CONNECTION);
  });
});

describe('readDatabaseNow', () => {
  beforeEach(forgetConnection);

  it('reads now() on the registered connection, outside any transaction', async () => {
    const connection = new FakeConnection();
    useTransactionalConnection(connection);

    assert.equal(await readDatabaseNow(), FAKE_NOW);
    assert.deepEqual(connection.queries, [
      {
        sql: 'SELECT now() AS now',
        options: { type: 'SELECT', plain: true, transaction: undefined },
      },
    ]);
  });

  it('answers the instant the database read', async () => {
    const at = new Date('2026-10-07T12:30:00Z');
    useTransactionalConnection(new FakeConnection({ now: at }));

    assert.equal(await readDatabaseNow(), at);
  });

  it('reads inside the transaction the caller runs in', async () => {
    const connection = new FakeConnection();
    useTransactionalConnection(connection);

    await new Clock().read();

    assert.equal(connection.queries.length, 1);
    assert.equal(connection.queries[0].options.transaction, connection.opened[0]);
  });

  it('reads inside the transaction passed in, over the current one', async () => {
    const connection = new FakeConnection();
    useTransactionalConnection(connection);
    const other = await new FakeConnection().transaction();

    await new Clock().readInside(other);

    assert.equal(connection.queries.length, 0);
    assert.equal(other.sequelize!.queries[0].options.transaction, other);
  });

  it("reads on the transaction's own connection, over the registered one", async () => {
    const registered = new FakeConnection();
    useTransactionalConnection(registered);
    const own = new FakeConnection();
    const transaction = await own.transaction();

    await readDatabaseNow({ transaction });

    assert.equal(own.queries.length, 1);
    assert.equal(registered.queries.length, 0);
  });

  it("reads on the connection passed in, over the transaction's own", async () => {
    const own = new FakeConnection();
    const passed = new FakeConnection();
    const transaction = await own.transaction();

    await readDatabaseNow({ transaction, connection: passed });

    assert.equal(own.queries.length, 0);
    assert.equal(passed.queries[0].options.transaction, transaction);
  });

  it('needs nothing but fn and query, as Sequelize types its instance', async () => {
    const given: unknown[] = [];
    const connection = {
      fn: (name: string) => new FakeConnection().fn(name),
      query: async (_sql: string, options: unknown) => {
        given.push(options);
        return { now: FAKE_NOW };
      },
    };

    assert.equal(await readDatabaseNow({ connection }), FAKE_NOW);
    assert.deepEqual(given, [{ type: 'SELECT', plain: true, transaction: undefined }]);
  });

  it('falls back to the registered connection for a transaction that carries none', async () => {
    const registered = new FakeConnection();
    useTransactionalConnection(registered);
    const transaction = new FakeTransaction();

    await readDatabaseNow({ transaction });

    assert.equal(registered.queries[0].options.transaction, transaction);
  });

  it('refuses when there is no connection to read on', async () => {
    await assert.rejects(readDatabaseNow(), NO_CLOCK_CONNECTION);
  });

  it('refuses a connection that builds SQL functions but cannot run a query', async () => {
    const connection = { fn: () => ({ clone: () => connection }) };

    await assert.rejects(readDatabaseNow({ connection: connection as never }), NO_CLOCK_CONNECTION);
  });
});
