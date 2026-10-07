import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as entry from './index.ts';

/** Every value the package exports: the README's API reference lists each one. */
const EXPORTED = [
  'TRANSACTIONAL_ERROR',
  'Transactional',
  'TransactionalError',
  'currentTransaction',
  'databaseNow',
  'readDatabaseNow',
  'registeredTransactionalConnection',
  'useTransactionalConnection',
];

describe('the package entry', () => {
  it('exports the documented API, and nothing internal', () => {
    assert.deepEqual(Object.keys(entry).sort(), [...EXPORTED].sort());
  });
});
