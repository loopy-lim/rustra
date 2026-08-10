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

test('throws on error response', () => {
  const native = createMockNative({ ok: false, error: 'command not found' });
  const engine = createReactNativeEngine(native);

  assert.throws(
    () => engine.invoke('missing'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'command not found');
      return true;
    },
  );
});

test('includes default error message when error is missing', () => {
  const native = createMockNative({ ok: false });
  const engine = createReactNativeEngine(native);

  assert.throws(
    () => engine.invoke('cmd'),
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

test('F3 baseline: sync throw from native.invoke bypasses .catch() (Promise<T> violation)', () => {
  // EngineClient 계약: invoke()는 Promise<T>를 반환해야 하므로,
  // 네이티브 실패는 반드시 rejected Promise여야 한다. 현재는 동기 throw.
  const engine = createReactNativeEngine({
    invoke() {
      throw new Error('native boom');
    },
  });
  let caughtByCatch = false;
  try {
    // .catch() idiom — 계약상 모든 실패는 여기서 잡혀야 함.
    engine.invoke('cmd', {}).catch(() => {
      caughtByCatch = true;
    });
  } catch {
    // 현재 결함: invoke()가 Promise를 반환하기 전에 동기 throw → .catch()가 안 붙음.
  }
  assert.equal(
    caughtByCatch,
    false,
    'F3: sync throw bypasses .catch() — Phase 1 async 전환 후 true로 단언 전환',
  );
});

test('F4 baseline: error response throws plain Error, not RustraCommandError (code lost)', () => {
  const engine = createReactNativeEngine(
    createMockNative({ ok: false, error: 'command.not_found: unknown' }),
  );
  assert.throws(
    () => engine.invoke('cmd', {}),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'is an Error');
      assert.ok(
        !(err instanceof RustraCommandError),
        'F4: NOT RustraCommandError (code lost) — Phase 1에서 RustraCommandError로 전환',
      );
      return true;
    },
  );
});
