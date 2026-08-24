import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap, createBunEngine } from './index.js';
import { RustraCommandError, type RkyvV2Codec } from '@rustra/types';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const addNumbersCodec: RkyvV2Codec<{ a: number; b: number }, { value: number }> = {
  commandId: 1,
  encode({ a, b }) {
    const zigzag = (value: number) => value * 2;
    return Uint8Array.from([1, 0, zigzag(a), zigzag(b)]).buffer;
  },
  decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 1) return { ok: false, error: { code: 'invoke.failed', message: 'failed' } };
    return { ok: true, result: { value: bytes[8]! / 2 } };
  },
};
const testRegistry = new Map<string, RkyvV2Codec<unknown, unknown>>([
  ['addNumbers', addNumbersCodec as RkyvV2Codec<unknown, unknown>],
]);

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

// ── Rust 와이어 에러 — Error.message 의 RustraError JSON/Display 복원 ──

test('createBunEngine parses RustraError JSON message from wire Error', async () => {
  // Rust 가 RustraError 를 JSON 직렬화해 Error 로 던지는 경우 code/retryable 을
  // 보존한다(unknown 래핑 금지 — @rustra/node 와 동일 파이프라인).
  const engine = createBunEngine({
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

test('createBunEngine parses Display-style "code: message" Error message', async () => {
  const engine = createBunEngine({
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

test('createBunBootstrap loads the stable Rustra ABI without transport boilerplate', async () => {
  const bootstrap = createBunBootstrap({
    libraryCandidates: [
      resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`),
      resolve(repoRoot, `target/debug/librustra_calculator_example.${suffix}`),
    ],
    rkyvV2Codecs: testRegistry,
  });
  try {
    const engine = await bootstrap.ready();
    const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(result.value, 42);
  } finally {
    bootstrap.dispose();
  }
});

test('createBunBootstrap gives an actionable library override hint', async () => {
  const previous = process.env.RUSTRA_BUN_LIBRARY;
  delete process.env.RUSTRA_BUN_LIBRARY;
  const bootstrap = createBunBootstrap({
    libraryCandidates: ['./missing-rustra-library'],
    rkyvV2Codecs: new Map(),
  });
  try {
    await assert.rejects(bootstrap.ready(), /RUSTRA_BUN_LIBRARY/);
  } finally {
    if (previous === undefined) delete process.env.RUSTRA_BUN_LIBRARY;
    else process.env.RUSTRA_BUN_LIBRARY = previous;
  }
});
