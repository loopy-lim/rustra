import assert from 'node:assert/strict';
import test from 'node:test';
import { createReactNativeEngine, RustraCommandError } from './index.js';

const encoder = new TextEncoder();

function createMockNative(returnValue: { ok: boolean; result?: unknown; error?: string }) {
  return {
    invoke(_payload: ArrayBuffer): ArrayBuffer {
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

test('F4: error response rejects with RustraCommandError carrying code', async () => {
  const engine = createReactNativeEngine(
    createMockNative({ ok: false, error: 'command.not_found: unknown' }),
  );
  await assert.rejects(
    async () => engine.invoke('cmd', {}),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError, 'must be RustraCommandError (code preserved)');
      assert.equal(
        (err as RustraCommandError).code,
        'command.not_found',
        'RustaError "code: message" → code parsed',
      );
      assert.match((err as Error).message, /unknown/);
      return true;
    },
  );
});

// ── subscribeEvent (Rust → JS push) ─────────────────────────

import { subscribeEvent } from './index.js';
import type { RustraEventNative } from './index.js';

type RecordedListener = { name: string; callback: (payloadJson: string) => void };

function createEventNative() {
  const listeners = new Map<string, (payloadJson: string) => void>();
  const calls: RecordedListener[] = [];
  const native = {
    onEvent(name: string, callback: (payloadJson: string) => void) {
      calls.push({ name, callback });
      listeners.set(name, callback);
    },
    offEvent(name: string) {
      listeners.delete(name);
    },
  };
  return {
    native,
    listeners,
    calls,
    emit(name: string, payloadJson: string) {
      listeners.get(name)?.(payloadJson);
    },
  };
}

test('subscribeEvent registers a native listener and parses the JSON payload once', () => {
  const h = createEventNative();
  const received: unknown[] = [];
  const payloadJson = JSON.stringify({ step: 1, total: 5 });

  subscribeEvent(h.native, 'progress.tick', (payload) => {
    received.push(payload);
  });

  assert.equal(h.calls.length, 1, 'native.onEvent must be called once');
  assert.equal(h.calls[0].name, 'progress.tick');
  h.emit('progress.tick', payloadJson);

  assert.deepEqual(received, [{ step: 1, total: 5 }], 'callback receives the parsed object');
});

test('subscribeEvent unsubscribe removes the native listener', () => {
  const h = createEventNative();

  const unsubscribe = subscribeEvent(h.native, 'demo.done', () => {});
  assert.equal(h.listeners.size, 1);
  unsubscribe();

  assert.equal(h.listeners.size, 0, 'offEvent must remove the listener');
});

test('subscribeEvent normalizes unparseable payloads to null', () => {
  const h = createEventNative();
  const received: unknown[] = [];

  subscribeEvent(h.native, 'bad.json', (payload) => {
    received.push(payload);
  });
  h.emit('bad.json', 'not-json{');

  assert.deepEqual(received, [null], 'broken JSON must arrive as null, not throw');
});

test('subscribeEvent no-ops when native has no onEvent (legacy bridge)', () => {
  // 구버전 네이티브 — onEvent/offEvent 미노출. throw 없이 no-op 구독 해제 반환.
  const legacy: RustraEventNative = {};
  const unsubscribe = subscribeEvent(legacy, 'any.event', () => {});
  unsubscribe(); // throw 하지 않아야 한다
});

test('subscribeEvent coexists with multiple event names', () => {
  const h = createEventNative();
  const ticks: unknown[] = [];
  const dones: unknown[] = [];

  subscribeEvent(h.native, 'progress.tick', (p) => ticks.push(p));
  subscribeEvent(h.native, 'demo.done', (p) => dones.push(p));
  h.emit('progress.tick', JSON.stringify({ step: 2 }));
  h.emit('demo.done', JSON.stringify({ emitted: 6 }));

  assert.deepEqual(ticks, [{ step: 2 }]);
  assert.deepEqual(dones, [{ emitted: 6 }]);
});

// ── createAsyncEngine (P0-3 + T1 얕은 취소) ─────────────────

import { createAsyncEngine } from './index.js';
import type { RustraJSIAsyncNative } from './index.js';

/**
 * invokeTypedAsync mock 네이티브 — 성공 콜백을 보류(defer)했다가 수동 전달한다.
 * calls 로 네이티브 호출 수를, resolveNow 로 늦은 resolve 를 흉내낸다.
 */
function makeAsyncNative() {
  const state = {
    calls: 0,
    delivered: false,
    resolveNow: () => {},
    rejectNow: (_msg: string) => {},
  };
  const native: RustraJSIAsyncNative = {
    invoke(_payload: ArrayBuffer): ArrayBuffer {
      return new ArrayBuffer(0);
    },
    invokeRkyvV2(_payload: ArrayBuffer): ArrayBuffer {
      return new ArrayBuffer(0);
    },
    invokeTypedAsync(
      _name: string,
      _args: unknown,
      onSuccess: (result: unknown) => void,
      onError: (message: string) => void,
    ) {
      state.calls++;
      state.resolveNow = () => {
        state.delivered = true;
        onSuccess({ value: 42 });
      };
      state.rejectNow = (msg: string) => {
        state.delivered = true;
        onError(msg);
      };
    },
  };
  return { native, state };
}

test('async engine without signal resolves via invokeTypedAsync (T1 baseline)', async () => {
  const h = makeAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const p = engine.invoke<{ value: number }>('heavy', { n: 1 });
  h.state.resolveNow(); // 네이티브 콜백 도착
  const out = await p;

  assert.equal(out.value, 42);
  assert.equal(h.state.calls, 1, 'invokeTypedAsync must be called exactly once');
});

test('async engine without signal rejects via invokeTypedAsync error callback (T1 baseline)', async () => {
  const h = makeAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const p = engine.invoke('heavy', { n: 1 });
  h.state.rejectNow('math.divide_by_zero: nope');
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'math.divide_by_zero');
    return true;
  });
});

test('pre-aborted signal rejects cancelled without calling invokeTypedAsync (T1)', async () => {
  const h = makeAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(engine.invoke('heavy', { n: 1 }, { signal: ac.signal }), (err: unknown) => {
    assert.ok(err instanceof RustraCommandError, 'must be RustraCommandError');
    assert.equal((err as RustraCommandError).code, 'cancelled');
    assert.equal((err as RustraCommandError).retryable, true, 'cancelled is retryable');
    assert.match((err as Error).message, /heavy/);
    return true;
  });
  assert.equal(h.state.calls, 0, 'native must never be called for a pre-aborted signal');
});

test('abort mid-flight rejects cancelled; late native resolve is ignored (T1)', async () => {
  const h = makeAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const ac = new AbortController();
  const p = engine.invoke<{ value: number }>('heavy', { n: 1 }, { signal: ac.signal });
  assert.equal(h.state.calls, 1, 'native must have been dispatched before abort');
  ac.abort(); // 진행 중 중단

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'cancelled');
    return true;
  });

  // 네이티브 성공 콜백이 abort 이후 늦게 도착 — 이미 정착된 프라미스는 그대로.
  h.state.resolveNow();
  await new Promise<void>((r) => queueMicrotask(() => r()));
  await assert.rejects(
    p,
    (err: unknown) =>
      err instanceof RustraCommandError && (err as RustraCommandError).code === 'cancelled',
    'promise must stay rejected (late resolve is a no-op)',
  );
  assert.equal(h.state.delivered, true, 'native callback did fire — it was just ignored');
});
