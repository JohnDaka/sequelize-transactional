import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { TRANSACTIONAL_ERROR, TransactionalError } from './errors.ts';
import {
  decorate,
  EVENT,
  FakeConnection,
  forgetConnection,
  type FakeTransaction,
} from './testing/fakes.ts';
import {
  currentTransaction,
  registeredTransactionalConnection,
  useTransactionalConnection,
  type TransactionLike,
} from './transactional.ts';

/** What the failing methods throw. */
const NO_STOCK = 'no stock';

/** A service whose decorated methods record what they were handed. */
class Orders {
  /** The last-argument transaction and `currentTransaction()`, as each call saw them. */
  public readonly seen: unknown[] = [];

  public async place(item: string, transaction?: TransactionLike): Promise<string> {
    this.seen.push(transaction, currentTransaction());
    return `order ${item}`;
  }

  public async fail(transaction?: TransactionLike): Promise<never> {
    this.seen.push(transaction);
    throw new Error(NO_STOCK);
  }

  /** Two nested decorated calls. */
  public async placeTwo(transaction?: TransactionLike): Promise<void> {
    this.seen.push(transaction);
    await this.place('a');
    await this.place('b');
  }

  /** A nested call that throws, not caught. */
  public async placeThenFail(transaction?: TransactionLike): Promise<void> {
    this.seen.push(transaction);
    await this.place('a');
    await this.fail();
  }

  /** A nested call that throws, caught: the outer method goes on and returns. */
  public async placeDespiteFailure(transaction?: TransactionLike): Promise<string> {
    this.seen.push(transaction);
    await this.fail().catch(() => undefined);
    return this.place('b');
  }
}
decorate(Orders.prototype, 'place', 'fail', 'placeTwo', 'placeThenFail', 'placeDespiteFailure');

describe('useTransactionalConnection', () => {
  beforeEach(forgetConnection);

  it('registers the connection registeredTransactionalConnection() answers', () => {
    const connection = new FakeConnection();
    assert.equal(registeredTransactionalConnection(), undefined);

    useTransactionalConnection(connection);

    assert.equal(registeredTransactionalConnection(), connection);
  });

  it('replaces the connection and the options on a second call', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const reported: unknown[] = [];
    useTransactionalConnection(first, { onRollback: (error) => reported.push(error) });

    useTransactionalConnection(second);
    await assert.rejects(new Orders().fail(), { message: NO_STOCK });

    assert.equal(registeredTransactionalConnection(), second);
    assert.equal(first.opened.length, 0);
    assert.deepEqual(second.events, [EVENT.ROLLBACK]);
    assert.deepEqual(reported, [], 'the onRollback left out is cleared');
  });
});

describe('@Transactional', () => {
  let connection: FakeConnection;
  let reported: unknown[];

  beforeEach(() => {
    connection = new FakeConnection();
    reported = [];
    useTransactionalConnection(connection, {
      onRollback: (error) => {
        reported.push(error);
        connection.events.push(EVENT.ON_ROLLBACK);
      },
    });
  });

  describe('one method', () => {
    it('runs it in a transaction handed over as the last argument, and commits', async () => {
      const orders = new Orders();

      assert.equal(await orders.place('x'), 'order x');

      const [transaction] = connection.opened;
      assert.equal(connection.opened.length, 1);
      assert.equal(transaction.ended, EVENT.COMMIT);
      assert.deepEqual(orders.seen, [transaction, transaction]);
    });

    it('commits before the caller gets the result', async () => {
      const result = await new Orders().place('x');

      assert.equal(result, 'order x');
      assert.deepEqual(connection.events, [EVENT.COMMIT]);
    });

    it('appends the transaction right after the arguments the caller passed', async () => {
      class Notes {
        public received: unknown[] = [];
        public async write(text: string, author?: string, transaction?: TransactionLike) {
          this.received = [text, author, transaction];
        }
      }
      decorate(Notes.prototype, 'write');
      const notes = new Notes();

      await notes.write('hello');

      const [transaction] = connection.opened;
      assert.deepEqual(notes.received, ['hello', transaction, undefined]);
    });

    it('rolls back and rethrows the very error the method threw', async () => {
      const failure = new Error(NO_STOCK);
      class Stock {
        public async take(): Promise<never> {
          throw failure;
        }
      }
      decorate(Stock.prototype, 'take');

      await assert.rejects(new Stock().take(), (error) => error === failure);

      assert.equal(connection.opened[0].ended, EVENT.ROLLBACK);
    });

    it('makes a method that is not async return a promise, committing what it returns', async () => {
      class Counter {
        public count = 0;
        public increment(): number {
          this.count += 1;
          return this.count;
        }
      }
      decorate(Counter.prototype, 'increment');

      const returned = new Counter().increment() as unknown;

      assert.ok(returned instanceof Promise);
      assert.equal(await returned, 1);
      assert.deepEqual(connection.events, [EVENT.COMMIT]);
    });

    it('rolls back when a method that is not async throws', async () => {
      class Counter {
        public explode(): never {
          throw new Error(NO_STOCK);
        }
      }
      decorate(Counter.prototype, 'explode');

      await assert.rejects(async () => new Counter().explode(), { message: NO_STOCK });
      assert.deepEqual(connection.events, [EVENT.ON_ROLLBACK, EVENT.ROLLBACK]);
    });
  });

  describe('nesting', () => {
    it('joins the outer transaction: one transaction, committed once by the outermost', async () => {
      const orders = new Orders();

      await orders.placeTwo();

      assert.equal(connection.opened.length, 1);
      const [transaction] = connection.opened;
      assert.deepEqual(connection.events, [EVENT.COMMIT]);
      assert.equal(orders.seen.length, 5);
      assert.ok(orders.seen.every((seen) => seen === transaction));
    });

    it('rolls the whole transaction back when an inner method throws', async () => {
      const orders = new Orders();

      await assert.rejects(orders.placeThenFail(), { message: NO_STOCK });

      assert.equal(connection.opened.length, 1);
      assert.deepEqual(connection.events, [EVENT.ON_ROLLBACK, EVENT.ROLLBACK]);
      assert.equal(reported.length, 1, 'reported once, by the outermost method');
    });

    it('commits when the outer method catches the inner error and returns', async () => {
      const orders = new Orders();

      assert.equal(await orders.placeDespiteFailure(), 'order b');

      const [transaction] = connection.opened;
      assert.equal(connection.opened.length, 1);
      assert.deepEqual(connection.events, [EVENT.COMMIT]);
      assert.ok(orders.seen.every((seen) => seen === transaction));
      assert.deepEqual(reported, []);
    });

    it('keeps concurrent calls apart: each runs in a transaction of its own', async () => {
      class Slow {
        public async run(transaction?: TransactionLike): Promise<unknown[]> {
          await sleep(1);
          return [transaction, currentTransaction()];
        }
      }
      decorate(Slow.prototype, 'run');
      const slow = new Slow();

      const [first, second] = await Promise.all([slow.run(), slow.run()]);

      assert.equal(connection.opened.length, 2);
      assert.deepEqual(first, [connection.opened[0], connection.opened[0]]);
      assert.deepEqual(second, [connection.opened[1], connection.opened[1]]);
    });
  });

  describe('currentTransaction', () => {
    it('is undefined outside a decorated method', () => {
      assert.equal(currentTransaction(), undefined);
    });

    it('is the transaction in helpers the method calls, across awaits and timers', async () => {
      const helper = (): unknown => currentTransaction();
      class Reports {
        public async build(transaction?: TransactionLike): Promise<unknown[]> {
          const before = helper();
          await sleep(1);
          const afterAwait = helper();
          const inTimer = await new Promise((resolve) => setImmediate(() => resolve(helper())));
          return [transaction, before, afterAwait, inTimer];
        }
      }
      decorate(Reports.prototype, 'build');

      const [transaction, ...seen] = await new Reports().build();

      assert.equal(transaction, connection.opened[0]);
      assert.deepEqual(seen, [transaction, transaction, transaction]);
    });

    it('is undefined again once the method has returned', async () => {
      await new Orders().place('x');

      assert.equal(currentTransaction(), undefined);
    });

    it("is typed as the app's own transaction when asked", async () => {
      class Typed {
        public async connectionOf(): Promise<unknown> {
          return currentTransaction<FakeTransaction>()?.sequelize;
        }
      }
      decorate(Typed.prototype, 'connectionOf');

      assert.equal(await new Typed().connectionOf(), connection);
    });
  });

  describe('onRollback', () => {
    it('is told the error, before the rollback', async () => {
      await assert.rejects(new Orders().fail(), { message: NO_STOCK });

      assert.deepEqual(connection.events, [EVENT.ON_ROLLBACK, EVENT.ROLLBACK]);
      assert.equal(reported.length, 1);
      assert.equal((reported[0] as Error).message, NO_STOCK);
    });

    it('is not told about a commit', async () => {
      await new Orders().place('x');

      assert.deepEqual(reported, []);
    });

    it('cannot keep the transaction open by throwing: it is rolled back all the same', async () => {
      const hookFailure = new Error('the logger is down');
      useTransactionalConnection(connection, {
        onRollback: () => {
          throw hookFailure;
        },
      });

      await assert.rejects(new Orders().fail(), (error) => error === hookFailure);

      assert.equal(connection.opened[0].ended, EVENT.ROLLBACK);
    });
  });

  describe('a commit that fails', () => {
    it('rejects with its own error, and is not followed by a rollback', async () => {
      const refused = new Error('a deferred constraint is violated');
      connection = new FakeConnection({ commitError: refused });
      useTransactionalConnection(connection, { onRollback: (error) => reported.push(error) });

      await assert.rejects(new Orders().place('x'), (error) => error === refused);

      assert.deepEqual(connection.events, [EVENT.COMMIT]);
      assert.deepEqual(reported, [], 'onRollback hears what the method threw, not the commit');
    });
  });

  describe('the connection', () => {
    beforeEach(forgetConnection);

    it('is the registered one, over one the instance carries', async () => {
      const registered = new FakeConnection();
      const carried = new FakeConnection();
      useTransactionalConnection(registered);

      await Object.assign(new Orders(), { sequelize: carried }).place('x');

      assert.equal(registered.opened.length, 1);
      assert.equal(carried.opened.length, 0);
    });

    it("falls back to the instance's sequelize field when none is registered", async () => {
      const carried = new FakeConnection();

      await Object.assign(new Orders(), { sequelize: carried }).place('x');

      assert.equal(carried.opened.length, 1);
      assert.equal(carried.opened[0].ended, EVENT.COMMIT);
    });

    it('falls back to any other field that holds a connection', async () => {
      const carried = new FakeConnection();

      await Object.assign(new Orders(), { database: carried }).place('x');

      assert.equal(carried.opened.length, 1);
    });

    it('takes the sequelize field over another field that holds a connection', async () => {
      const other = new FakeConnection();
      const carried = new FakeConnection();

      await Object.assign(new Orders(), { other, sequelize: carried }).place('x');

      assert.equal(carried.opened.length, 1);
      assert.equal(other.opened.length, 0);
    });

    it('passes over a sequelize field that is not a connection', async () => {
      const carried = new FakeConnection();
      const orders = Object.assign(new Orders(), { sequelize: { options: {} }, carried });

      await orders.place('x');

      assert.equal(carried.opened.length, 1);
    });

    it('accepts any object of the right shape, not only a Sequelize instance', async () => {
      const opened: unknown[] = [];
      const shaped = {
        getQueryInterface: () => ({}),
        transaction: async () => {
          const transaction = { commit: async () => undefined, rollback: async () => undefined };
          opened.push(transaction);
          return transaction;
        },
      };

      await Object.assign(new Orders(), { shaped }).place('x');

      assert.equal(opened.length, 1);
    });

    it('is not mistaken for anything else with a transaction method', async () => {
      const lookalike = { transaction: async () => new FakeConnection().transaction() };
      const orders = Object.assign(new Orders(), { sequelize: lookalike, lookalike });

      await assert.rejects(orders.place('x'), { code: TRANSACTIONAL_ERROR.NO_CONNECTION });
    });

    it('names the method when there is none at all', async () => {
      await assert.rejects(new Orders().place('x'), (error) => {
        assert.ok(error instanceof TransactionalError);
        assert.equal(error.code, TRANSACTIONAL_ERROR.NO_CONNECTION);
        assert.ok(error.message.includes('Orders.place'));
        return true;
      });
    });

    it('is looked up on every call: an instance that gains one later uses it', async () => {
      const orders = new Orders();
      await assert.rejects(orders.place('x'), { code: TRANSACTIONAL_ERROR.NO_CONNECTION });

      const carried = new FakeConnection();
      Object.assign(orders, { sequelize: carried });
      await orders.place('x');

      assert.equal(carried.opened.length, 1);
    });
  });
});
