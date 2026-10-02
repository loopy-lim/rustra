import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonEngine } from './json-engine.js';
import { RustraCommandError } from './errors.js';

test('JSON wire batch normalizes asynchronous transport rejection like a single invoke', async () => {
  const engine = createJsonEngine({
    invoke: async () => {
      throw { code: 'transport.error', message: 'IPC disconnected', retryable: true };
    },
    invokeBatch: async () => {
      throw { code: 'transport.error', message: 'IPC disconnected', retryable: true };
    },
  });
  for (const call of [() => engine.invoke('one'), () => engine.invokeBatch([{ command: 'one' }])]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof RustraCommandError);
      assert.equal(error.code, 'transport.error');
      assert.equal(error.message, 'IPC disconnected');
      assert.equal(error.retryable, true);
      return true;
    });
  }
});

test('JSON wire batch rejects missing, extra, and non-array response entries', async () => {
  for (const response of [undefined, {}, [1], [1, 2, 3]]) {
    const engine = createJsonEngine({
      invoke: () => undefined,
      invokeBatch: () => response as unknown[],
    });
    await assert.rejects(
      engine.invokeBatch([{ command: 'one' }, { command: 'two' }]),
      (error: unknown) =>
        error instanceof RustraCommandError && /batch response/.test(error.message),
    );
  }
});

test('JSON wire batch preserves void results and an empty batch keeps its single crossing', async () => {
  let crossings = 0;
  const engine = createJsonEngine({
    invoke: () => undefined,
    invokeBatch: (requests) => {
      crossings++;
      return requests.map(() => undefined);
    },
  });
  assert.deepEqual(await engine.invokeBatch([{ command: 'void' }]), [undefined]);
  assert.deepEqual(await engine.invokeBatch([]), []);
  assert.equal(crossings, 2);
});
