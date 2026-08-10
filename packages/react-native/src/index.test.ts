import assert from 'node:assert/strict';
import test from 'node:test';
import { createReactNativeEngine, RustraCommandError } from './index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createMockNative(returnValue: { ok: boolean; result?: unknown; error?: string }) {
  return {
    invoke(payload: ArrayBuffer): ArrayBuffer {
      return encoder.encode(JSON.stringify(returnValue)).buffer as ArrayBuffer;
    },
  };
}

test('routes invoke through JSI native module', async () => {
  const native = createMockNative({ ok: true, result: { value: 42 } });
  const engine = createReactNativeEngine(native);

  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
});

test('throws on error response', async () => {
  const native = createMockNative({ ok: false, error: 'command not found' });
  const engine = createReactNativeEngine(native);

  await assert.rejects(
    async () => engine.invoke('missing'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'command not found');
      return true;
    },
  );
});

test('includes default error message when error is missing', async () => {
  const native = createMockNative({ ok: false });
  const engine = createReactNativeEngine(native);

  await assert.rejects(
    async () => engine.invoke('cmd'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Rustra invoke failed');
      return true;
    },
  );
});

// ── Trust-test baselines (Phase 0) ──────────────────────────
// 현재 결함을 "현재 동작"으로 고정한다. Phase 1 수정 후 각 단언이
// 실패하며, 그때 새 동작(Promise.reject / RustraCommandError)으로 전환한다.

test('F3: native.invoke throw is caught by .catch() (Promise<T> honored)', async () => {
  // EngineClient 계약: invoke()는 Promise<T>를 반환해야 하므로,
  // 네이티브 실패는 반드시 rejected Promise여야 한다. async 전환 후
  // 동기 throw 는 rejected Promise 로 정규화되어 .catch() 에서 잡힌다.
  const engine = createReactNativeEngine({
    invoke() {
      throw new Error('native boom');
    },
  });
  let caughtByCatch = false;
  // async invoke 는 동기 throw 를 rejected Promise 로 정규화한다.
  // .catch() 체인을 await 해야 rejection handler(microtask) 가 실행된다.
  await engine.invoke('cmd', {}).catch(() => {
    caughtByCatch = true;
  });
  assert.equal(
    caughtByCatch,
    true,
    'F3: async invoke converts sync throw to rejected Promise — .catch() must catch it',
  );
});

test('F4 baseline: error response rejects with plain Error, not RustraCommandError (code lost)', async () => {
  const engine = createReactNativeEngine(
    createMockNative({ ok: false, error: 'command.not_found: unknown' }),
  );
  await assert.rejects(
    async () => engine.invoke('cmd', {}),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'is an Error');
      assert.ok(
        !(err instanceof RustraCommandError),
        'F4: NOT RustraCommandError (code lost) — Task 1.3에서 RustraCommandError로 전환',
      );
      return true;
    },
  );
});
