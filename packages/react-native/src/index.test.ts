import assert from 'node:assert/strict';
import test from 'node:test';
import { createReactNativeEngine } from './index.js';

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
