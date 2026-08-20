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

test('createTauriEngine wraps non-Error throws as unknown, Error messages via parser', async () => {
  // 문자열 throw 는 그대로 unknown 래핑 — Error 가 아니면 파서를 타지 않는다.
  const engine = createTauriEngine({
    async invoke() {
      throw 'transport died';
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

// ── Rust 와이어 에러 — Error.message 의 RustraError JSON/Display 복원 ──

test('createTauriEngine parses RustraError JSON message from wire Error', async () => {
  // Rust 가 RustraError 를 JSON 직렬화해 Error 로 던지는 경우 code/retryable 을
  // 보존한다(unknown 래핑 금지 — @rustra/node 와 동일 파이프라인).
  const engine = createTauriEngine({
    async invoke() {
      throw new Error('{"code":"command.not_found","message":"command not found: nope"}');
    },
  });

  await assert.rejects(
    () => engine.invoke('nope'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('createTauriEngine parses Display-style "code: message" Error message', async () => {
  const engine = createTauriEngine({
    async invoke() {
      throw new Error('command.not_found: nope');
    },
  });

  await assert.rejects(
    () => engine.invoke('nope'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.message, 'nope');
      return true;
    },
  );
});
