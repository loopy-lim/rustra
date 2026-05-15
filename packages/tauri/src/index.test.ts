import assert from 'node:assert/strict';
import test from 'node:test';
import { createTauriEngine } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('createTauriEngine routes invoke through rustra_dispatch', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createTauriEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return { value: 42 };
    },
  });

  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(calls, [
    { command: 'rustra_dispatch', args: { command: 'addNumbers', args: { a: 20, b: 22 } } },
  ]);
});

test('createTauriEngine normalizes undefined args to empty object', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createTauriEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return {};
    },
  });

  await engine.invoke('noArgs');
  assert.deepEqual(calls, [{ command: 'rustra_dispatch', args: { command: 'noArgs', args: {} } }]);
});

test('createTauriEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createTauriEngine({
    async invoke() {
      throw { code: 'command.invalid_args', message: 'bad input' };
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.invalid_args');
      assert.equal(err.message, 'bad input');
      return true;
    },
  );
});

test('createTauriEngine wraps unknown errors into RustraCommandError', async () => {
  const engine = createTauriEngine({
    async invoke() {
      throw new Error('transport died');
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'unknown');
      return true;
    },
  );
});
