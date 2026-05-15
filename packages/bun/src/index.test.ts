import assert from 'node:assert/strict';
import test from 'node:test';
import { createBunEngine } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('createBunEngine routes invoke to transport', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createBunEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return { value: 42 };
    },
  });

  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(calls, [{ command: 'addNumbers', args: { a: 20, b: 22 } }]);
});

test('createBunEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createBunEngine({
    async invoke() {
      throw { code: 'command.not_found', message: 'unknown command' };
    },
  });

  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.message, 'unknown command');
      return true;
    },
  );
});

test('createBunEngine wraps unknown errors into RustraCommandError', async () => {
  const engine = createBunEngine({
    async invoke() {
      throw 'something broke';
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal(err.code, 'unknown');
      assert.equal(err.message, 'something broke');
      return true;
    },
  );
});
