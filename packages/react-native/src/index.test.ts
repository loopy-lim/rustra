import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReactNativeEngine,
  createRustraBootstrap,
  createChannel,
  getRustraNative,
  RustraCommandError,
} from './index.js';
import type { RustraJSINative } from './index.js';
import { decodeUtf8, encodeUtf8, exactArrayBuffer } from '@rustra/types';

const encoder = new TextEncoder();

test('Hermes fallback encodes and decodes Korean and emoji without WHATWG globals', async () => {
  const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: undefined });
  try {
    const input = '안녕하세요 Rustra 🚀';
    const bytes = encodeUtf8(input);
    assert.equal(decodeUtf8(bytes), input);
    assert.deepEqual([...bytes], [...encoder.encode(input)]);
    assert.equal(exactArrayBuffer(bytes).byteLength, bytes.byteLength);
  } finally {
    if (encoderDescriptor) Object.defineProperty(globalThis, 'TextEncoder', encoderDescriptor);
    else Reflect.deleteProperty(globalThis, 'TextEncoder');
    if (decoderDescriptor) Object.defineProperty(globalThis, 'TextDecoder', decoderDescriptor);
    else Reflect.deleteProperty(globalThis, 'TextDecoder');
  }
});

function createMockNative(returnValue: { ok: boolean; result?: unknown; error?: string }) {
  return {
    invoke(_payload: ArrayBuffer): ArrayBuffer {
      return encoder.encode(JSON.stringify(returnValue)).buffer as ArrayBuffer;
    },
  };
}

test('missing JSI module error points through native linking to the Rust ABI', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globalRecord, '__rustraNative');
  Reflect.deleteProperty(globalRecord, '__rustraNative');
  try {
    assert.throws(
      () => getRustraNative(),
      (error: unknown) =>
        error instanceof Error &&
        /Expo Go/.test(error.message) &&
        /Rust static archive/.test(error.message) &&
        /extern "C" FFI symbols/.test(error.message),
    );
  } finally {
    if (previous) Object.defineProperty(globalRecord, '__rustraNative', previous);
  }
});

test('React Native bootstrap installs and configures once across concurrent readiness', async () => {
  let installs = 0;
  const native = {} as RustraJSINative;
  const bootstrap = createRustraBootstrap({
    install: async () => {
      installs++;
      await Promise.resolve();
    },
    getNative: () => native,
    rkyvV2Codecs: new Map(),
  });

  const [left, right] = await Promise.all([bootstrap.ready(), bootstrap.ready()]);
  assert.equal(installs, 1);
  assert.equal(left, right);
});

test('React Native bootstrap adds native-to-Rust remediation to install failures', async () => {
  const bootstrap = createRustraBootstrap({
    install: async () => {
      throw new Error('ERR_NO_BRIDGE');
    },
    getNative: () => ({}) as RustraJSINative,
    rkyvV2Codecs: new Map(),
  });

  await assert.rejects(
    bootstrap.ready(),
    (error: unknown) =>
      error instanceof Error &&
      /ERR_NO_BRIDGE/.test(error.message) &&
      /autolinking/.test(error.message) &&
      /Rust FFI symbols/.test(error.message),
  );
});

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

test('JSON adapter rejects a pre-aborted call without crossing native', async () => {
  let calls = 0;
  const engine = createReactNativeEngine({
    invoke() {
      calls++;
      return encoder.encode('{"ok":true,"result":1}').buffer as ArrayBuffer;
    },
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    engine.invoke('cancelled', undefined, { signal: ac.signal }),
    (error: unknown) => error instanceof RustraCommandError && error.code === 'cancelled',
  );
  assert.equal(calls, 0);
});

test('JSON adapter honors timeoutMs through the common timeout contract', async () => {
  const engine = createReactNativeEngine(createMockNative({ ok: true, result: 42 }));
  assert.equal(await engine.invoke('fast', undefined, { timeoutMs: 100 }), 42);
});

test('JSON adapter exposes Promise-based invokeBatch with stable order', async () => {
  const engine = createReactNativeEngine({
    invoke(payload) {
      const request = JSON.parse(decodeUtf8(payload)) as { command: string };
      return exactArrayBuffer(
        encodeUtf8(JSON.stringify({ ok: true, result: request.command === 'first' ? 1 : 2 })),
      );
    },
  });
  const out = await engine.invokeBatch<number>([{ command: 'first' }, { command: 'second' }]);
  assert.deepEqual(out, [1, 2]);
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

test('subscribeEvent supports the canonical name-first shape used by generated events', () => {
  const h = createEventNative();
  const root = globalThis as typeof globalThis & { __rustraNative?: unknown };
  const previous = root.__rustraNative;
  root.__rustraNative = h.native;
  const received: unknown[] = [];
  try {
    subscribeEvent('canonical.tick', (payload) => received.push(payload));
    h.emit('canonical.tick', JSON.stringify({ ok: true }));
    assert.deepEqual(received, [{ ok: true }]);
  } finally {
    root.__rustraNative = previous;
  }
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

test('subscribeEvent fails loudly when native has no event capability', () => {
  const legacy: RustraEventNative = {};
  assert.throws(
    () => subscribeEvent(legacy, 'any.event', () => {}),
    (error: unknown) => error instanceof RustraCommandError && error.code === 'event.unavailable',
  );
});

test('subscribeEvent allows an explicit legacy no-op fallback', () => {
  const legacy: RustraEventNative = {};
  const unsubscribe = subscribeEvent(legacy, 'any.event', () => {}, {
    allowMissingNative: true,
  });
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

test('createChannel exposes a typed handle and idempotent close', () => {
  let callback: ((payloadJson: string) => void) | undefined;
  const dropped: number[] = [];
  const channel = createChannel((payload) => assert.deepEqual(payload, { chunk: 1 }), {
    createChannel(next) {
      callback = next;
      return 42;
    },
    dropChannel(handle) {
      dropped.push(handle);
      return true;
    },
  });
  assert.equal(channel.handle, 42);
  callback!(JSON.stringify({ chunk: 1 }));
  assert.equal(channel.close(), true);
  assert.equal(channel.close(), false);
  assert.deepEqual(dropped, [42]);
});

test('createChannel rejects an invalid native handle instead of creating an unusable channel', () => {
  const native = {
    createChannel: () => Number.NaN,
    dropChannel: () => true,
  };
  assert.throws(() => createChannel(() => {}, native), /invalid handle/);
});

// ── createAsyncEngine (P0-3 + T1 얕은 취소) ─────────────────

import { createAsyncEngine, createFastEngine } from './index.js';
import type { RustraJSIAsyncNative } from './index.js';

// ── FastEngineOptions → core 옵션 전달 (follow-up 2) ───────
// 어댑터는 "전달됐는지"만 검증 — core 동작 상세는 @rustra/types 에서 이미 검증됨.

test('createFastEngine forwards maxPayloadBytes to the core pre-check', async () => {
  // maxPayloadBytes: 8 → 인코딩 후 8B 초과면 payload.too_large 로 네이티브 호출 없이 reject.
  const native: RustraJSINative = {
    invoke: () => new ArrayBuffer(0),
    invokeRkyvV2: () => {
      throw new Error('native must not be called for an over-limit payload');
    },
  };
  const codec = {
    commandId: 1,
    encode: () => new ArrayBuffer(16), // 16B > 8B limit
    decode: () => ({ ok: true, result: {} }),
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map([['big', codec]]),
    maxPayloadBytes: 8,
  });
  await assert.rejects(
    engine.invoke('big', {}),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'payload.too_large',
  );
});

test('createFastEngine forwards schemaVersion/onSchemaStale (stale warning path)', () => {
  const stale: unknown[] = [];
  const native: RustraJSINative = {
    invoke: () => new ArrayBuffer(0),
    invokeRkyvV2: () => new ArrayBuffer(8),
    getSchema: () =>
      encoder.encode(JSON.stringify({ schemaVersion: 1, commands: [] })).buffer as ArrayBuffer,
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map(),
    schemaVersion: 4,
    onSchemaStale: (info) => stale.push(info),
  });
  // 엔진 생성 시점에 staleness 검사가 돈다 — 옵션이 core 에 닿았으면 기록돼 있다.
  assert.ok(engine, 'engine is created');
  assert.deepEqual(stale, [{ nativeVersion: 1, jsVersion: 4 }]);
});

test('createFastEngine forwards onContractMismatch (degraded mode entry)', () => {
  const mismatches: unknown[] = [];
  const native: RustraJSINative = {
    invoke: () => new ArrayBuffer(0),
    invokeRkyvV2: () => new ArrayBuffer(0),
    getContractHash: () => encoder.encode('native-hash-AAAA').buffer as ArrayBuffer,
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map(),
    contractHash: 'different-hash-BBBB',
    onContractMismatch: (info) => mismatches.push(info),
  });
  assert.ok(engine, 'degraded mode — engine is created instead of throwing');
  assert.deepEqual(mismatches, [
    { nativeHash: 'native-hash-AAAA', expectedHash: 'different-hash-BBBB' },
  ]);
});

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

test('async engine exposes Promise-based invokeBatch with stable order', async () => {
  const native: RustraJSIAsyncNative = {
    invoke: () => new ArrayBuffer(0),
    invokeRkyvV2: () => new ArrayBuffer(0),
    invokeTypedAsync(name, _args, onSuccess) {
      onSuccess(name === 'first' ? 1 : 2);
      return 0;
    },
  };
  const engine = createAsyncEngine(native, { rkyvV2Codecs: new Map() });
  assert.deepEqual(
    await engine.invokeBatch<number>([{ command: 'first' }, { command: 'second' }]),
    [1, 2],
  );
});

test('createAsyncEngine reports when it falls back to the synchronous engine', () => {
  const native: RustraJSIAsyncNative = {
    invoke: () => new ArrayBuffer(0),
    invokeRkyvV2: () => new ArrayBuffer(0),
  };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    createAsyncEngine(native, { rkyvV2Codecs: new Map() });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((args) => String(args[0]).includes('synchronous')),
    'sync fallback must be visible to the developer',
  );
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

// ── follow-up 3: invokeTypedAsync id 노출 + 전파형 취소 ────

function makePropagatingAsyncNative() {
  const state = {
    lastId: -1,
    cancels: [] as number[],
    resolveNow: (_result: unknown) => {},
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
    ): number {
      state.lastId = 7; // 신형 네이티브 — id 반환
      state.resolveNow = (result) => onSuccess(result);
      state.rejectNow = (msg) => onError(msg);
      return state.lastId;
    },
    invokeCancel(invocationId: number): boolean {
      state.cancels.push(invocationId);
      return true;
    },
  };
  return { native, state };
}

test('abort mid-flight propagates: invokeCancel(id) is called (follow-up 3)', async () => {
  const h = makePropagatingAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const ac = new AbortController();
  const p = engine.invoke('heavy', { n: 1 }, { signal: ac.signal });
  assert.equal(h.state.lastId, 7, 'native issued an invocation id');
  ac.abort();

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'cancelled');
    return true;
  });
  assert.deepEqual(
    h.state.cancels,
    [7],
    'abort must propagate the invocation id to native.invokeCancel',
  );

  // 늦은 네이티브 성공 콜백 — 이미 정착된 프라미스는 그대로.
  h.state.resolveNow({ value: 42 });
  await new Promise<void>((r) => queueMicrotask(() => r()));
  await assert.rejects(
    p,
    (err: unknown) =>
      err instanceof RustraCommandError && (err as RustraCommandError).code === 'cancelled',
    'promise must stay rejected (late resolve is a no-op)',
  );
});

test('abort mid-flight propagates and late native error is ignored (follow-up 3)', async () => {
  const h = makePropagatingAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const ac = new AbortController();
  const p = engine.invoke('heavy', { n: 1 }, { signal: ac.signal });
  ac.abort();
  h.state.rejectNow('internal: late failure');

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'cancelled', 'abort wins over the late error');
    return true;
  });
});

test('signal path without invokeCancel falls back to shallow cancel (follow-up 3)', async () => {
  // 구형 네이티브 — invokeCancel 미노출 (void 반환). 얕은 취소로 폴백해야 한다.
  const h = makeAsyncNative();
  let cancelCalls = 0;
  const native: RustraJSIAsyncNative = {
    ...h.native,
    invokeCancel: (_id: number) => {
      cancelCalls++;
      return false;
    },
  };
  delete (native as { invokeCancel?: unknown }).invokeCancel; // 미노출 시뮬레이션
  const engine = createAsyncEngine(native, { rkyvV2Codecs: new Map() });

  const ac = new AbortController();
  const p = engine.invoke('heavy', { n: 1 }, { signal: ac.signal });
  ac.abort();

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'cancelled');
    return true;
  });
  assert.equal(cancelCalls, 0, 'no invokeCancel call in the shallow fallback');
});

test('new native without abort resolves normally through the id path (follow-up 3)', async () => {
  const h = makePropagatingAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });

  const p = engine.invoke<{ value: number }>('heavy', { n: 1 });
  h.state.resolveNow({ value: 42 });
  const out = await p;
  assert.equal(out.value, 42);
  assert.deepEqual(h.state.cancels, [], 'no cancel without an abort');
});

test('async engine applies timeoutMs and ignores a late native callback', async () => {
  const h = makeAsyncNative();
  const engine = createAsyncEngine(h.native, { rkyvV2Codecs: new Map() });
  const promise = engine.invoke('slow', undefined, { timeoutMs: 10 });
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof RustraCommandError && error.code === 'transport.timeout',
  );
  h.state.resolveNow();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof RustraCommandError && error.code === 'transport.timeout',
  );
});
