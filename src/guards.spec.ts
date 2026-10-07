import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { isFunction } from './guards.ts';

describe('isFunction', () => {
  it('is true for anything that can be called', () => {
    class Service {}
    const callables = [
      function named() {},
      () => undefined,
      async () => undefined,
      Service,
      Math.max,
    ];

    for (const callable of callables) {
      assert.equal(isFunction(callable), true, inspect(callable));
    }
  });

  it('is false for everything else', () => {
    const others = [undefined, null, 0, '', 'function', {}, [], { call: () => undefined }];

    for (const other of others) {
      assert.equal(isFunction(other), false, inspect(other));
    }
  });
});
