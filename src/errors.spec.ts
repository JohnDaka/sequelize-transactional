import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TRANSACTIONAL_ERROR, TransactionalError } from './errors.ts';

describe('TransactionalError', () => {
  it('is an Error named TransactionalError that carries its code', () => {
    const error = new TransactionalError(TRANSACTIONAL_ERROR.NO_CONNECTION, 'Orders.place');

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'TransactionalError');
    assert.equal(error.code, TRANSACTIONAL_ERROR.NO_CONNECTION);
  });

  it('names the method that has no connection, and the call that gives it one', () => {
    const { message } = new TransactionalError(TRANSACTIONAL_ERROR.NO_CONNECTION, 'Orders.place');

    assert.ok(message.includes('@Transactional on Orders.place has no connection'));
    assert.ok(message.includes('useTransactionalConnection(sequelize)'));
  });

  it('tells the clock how to get a connection', () => {
    const { message } = new TransactionalError(TRANSACTIONAL_ERROR.NO_CLOCK_CONNECTION);

    assert.ok(message.includes('The database clock needs a connection'));
    assert.ok(message.includes('useTransactionalConnection()'));
  });

  it('has a message for every code', () => {
    for (const code of Object.values(TRANSACTIONAL_ERROR)) {
      assert.notEqual(new TransactionalError(code).message, '', code);
    }
  });
});

describe('TRANSACTIONAL_ERROR', () => {
  it('names each code after itself, so a logged code reads as its constant', () => {
    for (const [name, code] of Object.entries(TRANSACTIONAL_ERROR)) {
      assert.equal(code, name);
    }
  });
});
