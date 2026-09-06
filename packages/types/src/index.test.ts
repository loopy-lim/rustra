// createRkyvV2Engine Tier 3 fallback + getLiveSchema 단위 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configure,
  configureLazy,
  createGeneratedFields2,
  createJsonEngine,
  createRkyvV2Engine,
  getLiveSchema,
  ensureConfigured,
  invoke,
  invokeBatch,
  invokeGeneratedBytes,
  invokeGenerated,
  invokeGeneratedFields2,
  invokeWithTimeout,
  raceAbort,
  RustraCommandError,
  CancelledError,
  TimeoutError,
  RustraErrorCode,
  parseRustraErrorString,
  normalizeRustraError,
  withRetry,
  configureDebug,
  debugWire,
  resetDebugEnvForTests,
} from './index.js';
import type { RkyvV2SchemaNative, RkyvV2Codec, BatchEntry, EngineClient } from './index.js';
// @internal 경로 — invokeByIdWithTimeout 은 index.js 공개 진입점 목록에 없고,
// unconfigured 상태 주입은 내부 runtime 조작이 필요하다 (테스트 전용 접근).
import { invokeByIdWithTimeout } from './cancel-by-id.js';
import { invokeCallbackWithAbort } from './cancel.js';
import { resetConfiguredRoutes, runtime } from './global-state.js';

test('lazy configuration lets the first generated command initialize Rustra once', async () => {
  let initializations = 0;
  let calls = 0;
  configureLazy(async () => {
    initializations++;
    await Promise.resolve();
    return {
      async invoke<T>(_command: string, args?: unknown): Promise<T> {
        calls++;
        const input = args as { a: number; b: number };
        return { value: input.a + input.b } as T;
      },
    };
  });
  const addNumbers = createGeneratedFields2<{ a: number; b: number }, { value: number }>(
    1,
    'addNumbers',
    'a',
    'b',
  );

  const [left, right] = await Promise.all([
    addNumbers({ a: 20, b: 22 }),
    addNumbers({ a: 40, b: 2 }),
  ]);

  assert.deepEqual(left, { value: 42 });
  assert.deepEqual(right, { value: 42 });
  assert.equal(initializations, 1, 'concurrent first calls must share native installation');
  assert.equal(calls, 2);
  assert.equal(await ensureConfigured(), await ensureConfigured());
});

test('lazy configuration retries after install failure and explicit configure wins a late install', async () => {
  let attempts = 0;
  configureLazy(async () => {
    attempts++;
    if (attempts === 1) throw new Error('native install failed');
    return { invoke: async <T>() => 'retried' as T };
  });
  await assert.rejects(invoke('retry'), /native install failed/);
  assert.equal(await invoke('retry'), 'retried');
  assert.equal(attempts, 2);

  let finishLate: ((engine: EngineClient) => void) | undefined;
  configureLazy(
    () =>
      new Promise<EngineClient>((resolve) => {
        finishLate = resolve;
      }),
  );
  const pending = invoke<string>('race');
  await Promise.resolve();
  configure({ invoke: async <T>() => 'explicit' as T });
  finishLate?.({ invoke: async <T>() => 'late' as T });
  assert.equal(await pending, 'explicit');
});

test('a newer lazy configuration wins an older initializer that finishes late', async () => {
  let finishOld!: (engine: EngineClient) => void;
  const oldEngine: EngineClient = { invoke: async <T>() => 'old' as T };
  const newEngine: EngineClient = { invoke: async <T>() => 'new' as T };

  configureLazy(() => new Promise<EngineClient>((resolve) => (finishOld = resolve)));
  const waiting = ensureConfigured();
  await Promise.resolve();
  configureLazy(() => newEngine);
  finishOld(oldEngine);

  assert.equal(await waiting, newEngine);
  assert.equal(await ensureConfigured(), newEngine);
});

test('duplicate package copies share one runtime configuration without singleton splits', async () => {
  const duplicateUrl = new URL(`./index.ts?duplicate=${Date.now()}`, import.meta.url).href;
  const duplicate = (await import(duplicateUrl)) as typeof import('./index.js');

  duplicate.configure({ invoke: async <T>() => 'from-duplicate' as T });
  assert.equal(await invoke('shared'), 'from-duplicate');

  configure({ invoke: async <T>() => 'from-primary' as T });
  assert.equal(await duplicate.invoke('shared'), 'from-primary');
});

// ── wire 헬퍼 (TS 측 Tier 3 wire) ───────────────────────────
// request:  [command_id: u16 LE @0][json @2]
// success:  [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
// error:    [ok:0 @0][pad to @8][err_len: u16 LE @8][postcard({code,message}) @10]

// ArrayBuffer 를 명시적으로 생성해 SharedArrayBuffer 호환 이슈를 피한다.
function bytesFromStrings(parts: string[]): ArrayBuffer {
  const enc = new TextEncoder();
  const encoded = parts.map((p) => enc.encode(p));
  const total = encoded.reduce((s, u) => s + u.length, 0);
  const ab = new ArrayBuffer(total);
  const view = new Uint8Array(ab);
  let off = 0;
  for (const u of encoded) {
    view.set(u, off);
    off += u.length;
  }
  return ab;
}

// postcard length-prefixed UTF-8 string
function pcString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  let len = bytes.length;
  const varint: number[] = [];
  do {
    let b = len & 0x7f;
    len >>>= 7;
    if (len > 0) b |= 0x80;
    varint.push(b);
  } while (len > 0);
  return new Uint8Array([...varint, ...bytes]);
}

function tier3Success(value: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const ab = new ArrayBuffer(8 + json.length);
  const view = new Uint8Array(ab);
  view[0] = 1; // ok
  new DataView(ab).setUint32(4, json.length, true);
  view.set(json, 8);
  return ab;
}

function tier3Error(code: string, message: string): ArrayBuffer {
  const body = pcString(code);
  const msg = pcString(message);
  const errLen = body.length + msg.length;
  const ab = new ArrayBuffer(10 + errLen);
  const view = new Uint8Array(ab);
  view[0] = 0; // error
  new DataView(ab).setUint16(8, errLen, true);
  view.set(body, 10);
  view.set(msg, 10 + body.length);
  return ab;
}

/**
 * 스키마 JSON 바이트. schemaVersion 을 명시하면 최상위 필드로 포함하고,
 * 생략하면 필드 자체를 없앤다 (T2 테스트: 구 네이티브 pre-Task-8 에뮬레이션).
 */
function schemaBytes(
  commands: Array<{ name: string; commandId: number } & Record<string, unknown>>,
  schemaVersion?: number,
  schemaGeneration?: number,
): ArrayBuffer {
  const doc: Record<string, unknown> =
    schemaVersion !== undefined
      ? { packageId: 't', schemaVersion, commands }
      : { packageId: 't', commands };
  if (schemaGeneration !== undefined) doc.schemaGeneration = schemaGeneration;
  return bytesFromStrings([JSON.stringify(doc)]);
}

interface NativeOpts {
  schema?: ArrayBuffer;
  invokeImpl?: (payload: ArrayBuffer) => ArrayBuffer;
  /** 네이티브가 노출하는 계약 해시(F5). undefined 면 getContractHash 를 노출하지 않는다. */
  contractHash?: string;
  /** (T0-3) FFI 세대 폴링. undefined 면 네이티브가 노출하지 않는 것으로 간주. */
  schemaGeneration?: () => number;
}

function makeNative(opts: NativeOpts): RkyvV2SchemaNative {
  const native: RkyvV2SchemaNative = {
    getSchema: () => opts.schema ?? schemaBytes([]),
    invokeRkyvV2: (payload) => (opts.invokeImpl ? opts.invokeImpl(payload) : new ArrayBuffer(0)),
  };
  if (opts.contractHash !== undefined) {
    native.getContractHash = () =>
      new TextEncoder().encode(opts.contractHash!).buffer as ArrayBuffer;
  }
  if (opts.schemaGeneration !== undefined) {
    native.getSchemaGeneration = opts.schemaGeneration;
  }
  return native;
}

// ── getLiveSchema ──────────────────────────────────────────

test('getLiveSchema parses commands into a name→entry map', () => {
  const native = makeNative({
    schema: schemaBytes([
      { name: 'echo', commandId: 1 },
      { name: 'average', commandId: 2 },
    ]),
  });
  const map = getLiveSchema(native);
  assert.equal(map.get('echo')?.commandId, 1);
  assert.equal(map.get('average')?.commandId, 2);
  assert.equal(map.size, 2);
});

test('getLiveSchema throws schema.unavailable when getSchema missing', () => {
  // (의미론 마감) getSchema 미노출은 "빈 스키마"가 아니라 조회 불능 —
  // 조용한 빈 Map 대신 명시적 에러.
  const native = { invokeRkyvV2: () => new ArrayBuffer(0) } as RkyvV2SchemaNative;
  assert.throws(
    () => getLiveSchema(native),
    (e: unknown) => e instanceof RustraCommandError && e.code === 'schema.unavailable',
  );
  // 엔진의 tier-3 디스패치는 이를 흡수해 기존 command.not_found 계약 유지.
  const engine = createRkyvV2Engine(native, new Map());
  return assert.rejects(
    engine.invoke('dynCmd', {}),
    (e: unknown) => e instanceof RustraCommandError && e.code === 'command.not_found',
  );
});

// ── createRkyvV2Engine: 정적 codec fast-path ────────────────

test('engine uses static codec when present (postcard fast-path)', async () => {
  let invoked = false;
  const native = makeNative({
    invokeImpl: () => {
      invoked = true;
      return tier3Success({ value: 42 });
    },
  });
  const codec: RkyvV2Codec<{ a: number }, { value: number }> = {
    commandId: 1,
    encode: () => new ArrayBuffer(2),
    decode: () => ({ ok: true, result: { value: 42 } }),
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['add', codec]]);
  const engine = createRkyvV2Engine(native, registry);
  const out = await engine.invoke<{ value: number }>('add', { a: 1 });
  assert.equal(out.value, 42);
  assert.equal(invoked, true);
});

// ── createRkyvV2Engine: 동적 Tier 3 fallback ────────────────

test('engine falls back to Tier 3 for non-codegen dynamic commands', async () => {
  // holder 패턴 — closure 내 할당을 TS CFA 가 놓치지 않도록.
  const holder: { req: ArrayBuffer | null } = { req: null };
  const native = makeNative({
    schema: schemaBytes([{ name: 'echo', commandId: 7 }]),
    invokeImpl: (payload) => {
      holder.req = payload;
      return tier3Success({ v: 7 });
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invoke<{ v: number }>('echo', { v: 7 });
  assert.equal(out.v, 7);

  const req = holder.req as ArrayBuffer;
  assert.ok(req);
  const view = new Uint8Array(req);
  // 요청 wire: [command_id: u16 LE @0] = 7
  const id = new DataView(req).getUint16(0, true);
  assert.equal(id, 7, 'Tier 3 request must carry live-schema commandId');
  // 그 뒤는 JSON
  const json = new TextDecoder().decode(view.slice(2));
  assert.equal(json, JSON.stringify({ v: 7 }));
});

test('Hermes UTF-8 fallback preserves long Korean and emoji payloads', async () => {
  // 현재 테스트 파일은 index.js를 이미 import했으므로 query가 붙은 별도 모듈
  // 인스턴스를 로드해 TextEncoder가 없는 Hermes 초기화 시점을 재현한다.
  const schema = schemaBytes([{ name: 'echoUnicode', commandId: 77 }]);
  const response = tier3Success({ ok: true });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  Object.defineProperty(globalThis, 'TextEncoder', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const moduleUrl = new URL('./index.js?hermes-utf8-fallback', import.meta.url).href;
    const fallback = (await import(moduleUrl)) as typeof import('./index.js');
    let captured: Uint8Array | undefined;
    const native: RkyvV2SchemaNative = {
      getSchema: () => schema,
      invokeRkyvV2(payload) {
        captured = new Uint8Array(payload).slice();
        return response;
      },
    };
    const input = {
      text: `${'한글'.repeat(64)}🙂🚀${'경계'.repeat(65)}`,
    };
    await fallback.createRkyvV2Engine(native, new Map()).invoke('echoUnicode', input);

    assert.ok(captured, 'Tier 3 request must reach the native boundary');
    assert.equal(new DataView(captured.buffer).getUint16(0, true), 77);
    assert.deepEqual(
      captured.subarray(2),
      new Uint8Array(Buffer.from(JSON.stringify(input), 'utf8')),
      'pure-JS fallback bytes must exactly match WHATWG UTF-8 output',
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'TextEncoder', descriptor);
    else Reflect.deleteProperty(globalThis, 'TextEncoder');
  }
});

test('engine Tier 3 fallback decodes string/vec/nested result types', async () => {
  const native = makeNative({
    schema: schemaBytes([
      { name: 'greet', commandId: 1 },
      { name: 'list', commandId: 2 },
      { name: 'nested', commandId: 3 },
    ]),
    invokeImpl: (payload) => {
      const id = new DataView(payload).getUint16(0, true);
      if (id === 1) return tier3Success({ message: 'hello' });
      if (id === 2) return tier3Success({ items: [1, 2, 3], count: 3 });
      return tier3Success({ outer: { inner: { v: 99 }, tags: ['a', 'b'] } });
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const g = await engine.invoke<{ message: string }>('greet', {});
  assert.equal(g.message, 'hello');
  const l = await engine.invoke<{ items: number[]; count: number }>('list', {});
  assert.deepEqual(l.items, [1, 2, 3]);
  assert.equal(l.count, 3);
  const n = await engine.invoke<{ outer: { inner: { v: number }; tags: string[] } }>('nested', {});
  assert.equal(n.outer.inner.v, 99);
  assert.deepEqual(n.outer.tags, ['a', 'b']);
});

test('engine caches live schema on the dynamic hot path and supports explicit refresh', async () => {
  let calls = 0;
  let schema = schemaBytes([{ name: 'dynamicEcho', commandId: 31 }]);
  const native: RkyvV2SchemaNative = {
    getSchema() {
      calls += 1;
      return schema;
    },
    invokeRkyvV2: () => tier3Success({ value: 42 }),
  };
  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke('dynamicEcho', { value: 1 });
  await engine.invoke('dynamicEcho', { value: 2 });
  assert.equal(calls, 1, 'cached dynamic command must not parse live schema per invoke');

  schema = schemaBytes([
    { name: 'dynamicEcho', commandId: 31 },
    { name: 'registeredLater', commandId: 32 },
  ]);
  const refreshed = engine.refreshLiveSchema();
  assert.equal(refreshed.get('registeredLater')?.commandId, 32);
  assert.equal(calls, 2);
  await engine.invoke('registeredLater', {});
  assert.equal(calls, 2, 'refreshed entry must immediately use the cache');
});

test('engine Tier 3 fallback propagates typed error wire', async () => {
  const native = makeNative({
    schema: schemaBytes([{ name: 'boom', commandId: 1 }]),
    invokeImpl: () => tier3Error('math.divide_by_zero', 'handler exploded'),
  });
  const engine = createRkyvV2Engine(native, new Map());
  // invoke 가 에러 시 동기 throw 하므로 async 래퍼로 rejection 처리.
  await assert.rejects(
    async () => {
      await engine.invoke('boom', {});
    },
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError, 'must be RustraCommandError');
      assert.equal((err as RustraCommandError).code, 'math.divide_by_zero');
      assert.match((err as Error).message, /handler exploded/);
      return true;
    },
  );
});

test('engine throws RustraCommandError for command absent from registry AND live schema (F4)', async () => {
  const native = makeNative({
    schema: schemaBytes([{ name: 'known', commandId: 1 }]),
    invokeImpl: () => tier3Success({}),
  });
  const engine = createRkyvV2Engine(native, new Map());
  await assert.rejects(
    async () => {
      await engine.invoke('unknown', {});
    },
    (err: Error) => {
      assert.match(err.message, /no codec and not in live schema/);
      assert.ok(
        err instanceof RustraCommandError,
        'F4: unknown-command must be RustraCommandError',
      );
      assert.equal(
        (err as RustraCommandError).code,
        'command.not_found',
        'code distinguishes unknown-command from handler errors',
      );
      return true;
    },
  );
});

test('engine throws when native has no getSchema and command not in registry', async () => {
  const native = { invokeRkyvV2: () => new ArrayBuffer(0) } as RkyvV2SchemaNative;
  const engine = createRkyvV2Engine(native, new Map());
  await assert.rejects(
    async () => {
      await engine.invoke('dyn', {});
    },
    (err: Error) => /no codec and not in live schema/.test(err.message),
  );
});

// ── createRkyvV2Engine: B1 (C++ invokeTyped fast path) ──────

/**
 * 정적 명령 이름들로 최소 registry 를 만든다 (P0-3). 정적-id 캐시 스윕은
 * registry 를 기준으로 돌므로 typed 경로를 타는 테스트는 대상 이름들이
 * registry 에 있어야 한다 — 실제 앱에서 registry 는 코드젠 산출물로
 * 정적 명령을 전부 담고 있는 것과 동일한 형태다.
 */
function staticRegistry(...names: string[]): Map<string, RkyvV2Codec<unknown, unknown>> {
  return new Map(
    names.map((name, i) => [
      name,
      {
        commandId: i + 1,
        encode: () => new ArrayBuffer(2),
        decode: () => ({ ok: true, result: {} }),
      },
    ]),
  );
}

/** makeNative 결과에 typed 코덱 메서드를 붙인 네이티브를 만든다. */
function makeTypedNative(
  opts: NativeOpts & {
    hasStaticCodec?: (name: string) => boolean;
    invokeTyped?: (name: string, args: unknown) => unknown;
    invokeTypedBatch?: (names: string[], args: unknown[]) => unknown[];
    invokeTypedById?: (cmdId: number, args: unknown) => unknown;
    invokeTypedBatchById?: (cmdIds: number[], args: unknown[]) => unknown[];
    getCodecCapabilities?: (cmdId: number) => number;
    invokeTypedRaw?: (cmdId: number, ...fields: unknown[]) => unknown;
    invokeTypedPos?: (cmdId: number, ...fields: unknown[]) => unknown;
    invokeTypedBuffer?: (cmdId: number, value: Uint8Array | ArrayBuffer) => unknown;
  },
): RkyvV2SchemaNative {
  const base = makeNative(opts);
  const typed: RkyvV2SchemaNative = { ...base };
  if (opts.hasStaticCodec) typed.hasStaticCodec = opts.hasStaticCodec;
  if (opts.invokeTyped) typed.invokeTyped = opts.invokeTyped;
  if (opts.invokeTypedBatch) typed.invokeTypedBatch = opts.invokeTypedBatch;
  if (opts.invokeTypedById) typed.invokeTypedById = opts.invokeTypedById;
  if (opts.invokeTypedBatchById) typed.invokeTypedBatchById = opts.invokeTypedBatchById;
  if (opts.getCodecCapabilities) typed.getCodecCapabilities = opts.getCodecCapabilities;
  if (opts.invokeTypedRaw) typed.invokeTypedRaw = opts.invokeTypedRaw;
  if (opts.invokeTypedPos) typed.invokeTypedPos = opts.invokeTypedPos;
  if (opts.invokeTypedBuffer) typed.invokeTypedBuffer = opts.invokeTypedBuffer;
  return typed;
}

test('engine uses C++ invokeTyped fast path when hasStaticCodec is true (B1)', async () => {
  let typedCalled = false;
  let invokeRkyvCalled = false;
  const native = makeTypedNative({
    invokeImpl: () => {
      invokeRkyvCalled = true;
      return tier3Success({ value: 0 });
    },
    hasStaticCodec: (name) => name === 'add',
    invokeTyped: () => {
      typedCalled = true;
      return { value: 42 };
    },
  });
  // registry 에 codec 이 있어도 B1 path 가 우선해야 한다.
  const codec: RkyvV2Codec<{ a: number }, { value: number }> = {
    commandId: 1,
    encode: () => new ArrayBuffer(2),
    decode: () => ({ ok: true, result: { value: 0 } }),
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['add', codec]]);
  const engine = createRkyvV2Engine(native, registry);
  const out = await engine.invoke<{ value: number }>('add', { a: 1 });
  assert.equal(out.value, 42);
  assert.equal(typedCalled, true, 'invokeTyped must be called');
  assert.equal(invokeRkyvCalled, false, 'invokeRkyvV2/JS codec must be bypassed on B1 path');
});

test('engine falls through B1 path when hasStaticCodec returns false', async () => {
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 5 }]),
    invokeImpl: () => tier3Success({ v: 9 }),
    hasStaticCodec: () => false, // 동적 명령 → Tier 3 로 폴백
    invokeTyped: () => {
      throw new Error('invokeTyped must not be called for dynamic commands');
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invoke<{ v: number }>('dyn', {});
  assert.equal(out.v, 9);
});

test('engine propagates invokeTyped errors (B1, Rust handler failure)', async () => {
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => {
      throw new Error('rust handler exploded');
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add'));
  await assert.rejects(
    async () => {
      await engine.invoke('add', {});
    },
    (err: Error) => /rust handler exploded/.test(err.message),
  );
});

// ── createRkyvV2Engine: byId 진입 + 정적 명령 집합 JS 캐시 (P0-#3) ──

test('typed dispatch uses invokeTypedById when available (P0-3)', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: (name) => {
      calls.push(`has:${name}`);
      return name === 'addNumbers';
    },
    invokeTyped: (name) => {
      calls.push(`typed:${name}`);
      return { value: 0 };
    },
    invokeTypedById: (id) => {
      calls.push(`byId:${id}`);
      return { value: 3 };
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    [
      'addNumbers',
      {
        commandId: 1,
        encode: () => new ArrayBuffer(4),
        decode: () => ({ ok: true, result: { value: 0 } }),
      },
    ],
  ]);
  const engine = createRkyvV2Engine(native, registry);

  // 1) 결과가 byId 경로 값
  const out = await engine.invoke<{ value: number }>('addNumbers', { a: 1, b: 2 });
  assert.equal(out.value, 3, 'result must come from the byId entry point');
  // 2) byId:1 호출
  assert.ok(calls.includes('byId:1'), 'invokeTypedById must be called with the registry cmdId');
  // 3) invokeTypedFallback 미사용
  assert.ok(!calls.some((c) => c.startsWith('typed:')), 'name-based invokeTyped must not run');
  // 4) 두 번째 invoke — 캐시로 hasStaticCodec 재호출 없음
  await engine.invoke<{ value: number }>('addNumbers', { a: 2, b: 3 });
  const hasCount = calls.filter((c) => c.startsWith('has:')).length;
  assert.equal(
    hasCount,
    1,
    `hasStaticCodec must run once for the initial sweep (registry size 1), got ${hasCount}`,
  );
});

test('generated dispatch uses its verified numeric id without name dispatch', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: (name) => {
      calls.push(`typed:${name}`);
      return { value: 0 };
    },
    invokeTypedById: (id) => {
      calls.push(`byId:${id}`);
      return { value: 42 };
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('addNumbers'));

  const out = await engine.invokeById<{ value: number }>(1, 'addNumbers', { a: 20, b: 22 });

  assert.equal(out.value, 42);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('byId:')),
    ['byId:1'],
  );
  assert.ok(!calls.some((call) => call.startsWith('typed:')));
});

test('generated dispatch safely re-resolves the registered id when id and name disagree', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: (name) => {
      calls.push(`typed:${name}`);
      return { value: 7 };
    },
    invokeTypedById: (id) => {
      calls.push(`byId:${id}`);
      return { value: 99 };
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('addNumbers'));

  const out = await engine.invokeById<{ value: number }>(99, 'addNumbers', {});

  assert.equal(out.value, 99);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('byId:')),
    ['byId:1'],
  );
  assert.ok(!calls.some((call) => call === 'byId:99'));
});

test('generated field dispatch selects raw before positional and preserves output shape', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: (id) => {
      calls.push(`cap:${id}`);
      return 1 | 2 | 4;
    },
    invokeTypedById: () => {
      calls.push('byId');
      return { value: -1 };
    },
    invokeTypedRaw: (id, ...fields) => {
      calls.push(`raw:${id}:${fields.join(',')}`);
      return { value: Number(fields[0]) + Number(fields[1]) };
    },
    invokeTypedPos: () => {
      calls.push('pos');
      return { value: -2 };
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('addNumbers'));
  configure(engine);

  const input = { a: 20, b: 22 };
  const out = await invokeGeneratedFields2<{ value: number }>(
    1,
    'addNumbers',
    input,
    input.a,
    input.b,
  );

  assert.deepEqual(out, { value: 42 });
  assert.deepEqual(calls, ['cap:1', 'raw:1:20,22']);
});

test('generated field dispatch falls from raw marker to positional', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 2 | 4,
    invokeTypedById: () => ({ value: -1 }),
    invokeTypedRaw: () => {
      calls.push('raw');
      return Number.NaN;
    },
    invokeTypedPos: (_id, ...fields) => {
      calls.push('pos');
      return { value: Number(fields[0]) + Number(fields[1]) };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('addNumbers')));

  const out = await invokeGeneratedFields2<{ value: number }>(
    1,
    'addNumbers',
    { a: 20, b: 22 },
    20,
    22,
  );

  assert.deepEqual(out, { value: 42 });
  assert.deepEqual(calls, ['raw', 'pos']);
});

test('generated field dispatch keeps old-native by-id fallback', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => ({ value: -1 }),
    invokeTypedById: (id, args) => {
      calls.push(`byId:${id}`);
      const input = args as { a: number; b: number };
      return { value: input.a + input.b };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('addNumbers')));

  const out = await invokeGeneratedFields2<{ value: number }>(
    1,
    'addNumbers',
    { a: 20, b: 22 },
    20,
    22,
  );

  assert.deepEqual(out, { value: 42 });
  assert.deepEqual(calls, ['byId:1']);
});

test('generated field dispatch uses the established option path', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 2 | 4,
    invokeTypedById: () => {
      calls.push('byId');
      return { value: 42 };
    },
    invokeTypedRaw: () => {
      calls.push('raw');
      return { value: 42 };
    },
    invokeTypedPos: () => {
      calls.push('pos');
      return { value: 42 };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('addNumbers')));

  const out = await invokeGeneratedFields2<{ value: number }>(
    1,
    'addNumbers',
    { a: 20, b: 22 },
    20,
    22,
    { timeoutMs: 100 },
  );

  assert.deepEqual(out, { value: 42 });
  assert.deepEqual(calls, ['byId']);
});

test('generated two-field command caches the native route and preserves metadata', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: (id) => {
      calls.push(`cap:${id}`);
      return 1 | 2 | 4;
    },
    invokeTypedById: () => ({ value: -1 }),
    invokeTypedRaw: (id, ...fields) => {
      calls.push(`raw:${id}`);
      return { value: Number(fields[0]) + Number(fields[1]) };
    },
  });
  const addNumbers = createGeneratedFields2<{ a: number; b: number }, { value: number }>(
    1,
    'addNumbers',
    'a',
    'b',
    'addNumbers',
  );
  configure(createRkyvV2Engine(native, staticRegistry('addNumbers')));

  assert.deepEqual(await addNumbers({ a: 20, b: 22 }), { value: 42 });
  assert.deepEqual(await addNumbers({ a: 1, b: 2 }), { value: 3 });
  assert.equal(addNumbers.commandId, 'addNumbers');
  assert.equal(addNumbers.name, 'addNumbers');
  assert.deepEqual(calls, ['cap:1', 'raw:1', 'raw:1']);
});

test('generated two-field command invalidates its route after configure', async () => {
  const addNumbers = createGeneratedFields2<{ a: number; b: number }, { value: number }>(
    1,
    'addNumbers',
    'a',
    'b',
  );
  const engineForOffset = (offset: number) =>
    createRkyvV2Engine(
      makeTypedNative({
        getCodecCapabilities: () => 1 | 2 | 4,
        invokeTypedById: () => ({ value: -1 }),
        invokeTypedRaw: (_id, ...fields) => ({
          value: Number(fields[0]) + Number(fields[1]) + offset,
        }),
      }),
      staticRegistry('addNumbers'),
    );

  configure(engineForOffset(0));
  assert.deepEqual(await addNumbers({ a: 20, b: 22 }), { value: 42 });
  configure(engineForOffset(100));
  assert.deepEqual(await addNumbers({ a: 20, b: 22 }), { value: 142 });
});

test('generated two-field command keeps options on the established path', async () => {
  const calls: string[] = [];
  const addNumbers = createGeneratedFields2<{ a: number; b: number }, { value: number }>(
    1,
    'addNumbers',
    'a',
    'b',
  );
  configure(
    createRkyvV2Engine(
      makeTypedNative({
        getCodecCapabilities: () => 1 | 2 | 4,
        invokeTypedById: () => {
          calls.push('byId');
          return { value: 42 };
        },
        invokeTypedRaw: () => {
          calls.push('raw');
          return { value: 42 };
        },
      }),
      staticRegistry('addNumbers'),
    ),
  );

  assert.deepEqual(await addNumbers({ a: 20, b: 22 }, { timeoutMs: 100 }), { value: 42 });
  assert.deepEqual(calls, ['byId']);
});

test('generated bytes dispatch selects the dedicated native path for ArrayBuffer views', async () => {
  const calls: string[] = [];
  const source = new Uint8Array([9, 1, 2, 3, 8]);
  const view = source.subarray(1, 4);
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 2 | 8,
    invokeTypedById: () => {
      calls.push('byId');
      return { data: [] };
    },
    invokeTypedPos: () => {
      calls.push('pos');
      return { data: [] };
    },
    invokeTypedBuffer: (id, value) => {
      calls.push(`buffer:${id}`);
      assert.equal(value, view, 'the native host must receive the original subarray view');
      return { data: new Uint8Array([1, 2, 3]).buffer };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('echoBytes')));

  const out = await invokeGeneratedBytes<{ data: ArrayBuffer }>(
    1,
    'echoBytes',
    { data: view },
    view,
  );

  assert.deepEqual([...new Uint8Array(out.data)], [1, 2, 3]);
  assert.deepEqual(calls, ['buffer:1']);
});

test('generated bytes dispatch accepts ArrayBuffer including an empty buffer', async () => {
  const seen: number[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 8,
    invokeTypedById: () => ({ data: [] }),
    invokeTypedBuffer: (_id, value) => {
      seen.push(value.byteLength);
      return { data: new ArrayBuffer(0) };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('echoBytes')));

  await invokeGeneratedBytes(1, 'echoBytes', { data: new ArrayBuffer(0) }, new ArrayBuffer(0));

  assert.deepEqual(seen, [0]);
});

test('generated bytes keeps number arrays and missing buffer methods on compatible fallbacks', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 2 | 8,
    invokeTypedById: () => {
      calls.push('byId');
      return { data: [] };
    },
    invokeTypedPos: (_id, value) => {
      calls.push(`pos:${Array.isArray(value) ? 'array' : 'buffer'}`);
      return { data: value };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('echoBytes')));

  await invokeGeneratedBytes(1, 'echoBytes', { data: [1, 2] }, [1, 2]);
  await invokeGeneratedBytes(1, 'echoBytes', { data: new Uint8Array([3]) }, new Uint8Array([3]));

  assert.deepEqual(calls, ['pos:array', 'pos:buffer']);
});

test('generated bytes bypasses the new route for options and mismatched ids', async () => {
  const calls: string[] = [];
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 8,
    invokeTypedById: (id) => {
      calls.push(`byId:${id}`);
      return { data: new ArrayBuffer(0) };
    },
    invokeTypedBuffer: () => {
      calls.push('buffer');
      return { data: new ArrayBuffer(0) };
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('echoBytes')));

  await invokeGeneratedBytes(1, 'echoBytes', { data: new ArrayBuffer(0) }, new ArrayBuffer(0), {
    timeoutMs: 100,
  });
  await invokeGeneratedBytes(99, 'echoBytes', { data: new ArrayBuffer(0) }, new ArrayBuffer(0));

  assert.deepEqual(calls, ['byId:1', 'byId:1']);
});

test('generated bytes converts native synchronous errors to rejected promises', async () => {
  const native = makeTypedNative({
    getCodecCapabilities: () => 1 | 8,
    invokeTypedById: () => ({ data: [] }),
    invokeTypedBuffer: () => {
      throw new Error('detached byte buffer');
    },
  });
  configure(createRkyvV2Engine(native, staticRegistry('echoBytes')));

  await assert.rejects(
    invokeGeneratedBytes(1, 'echoBytes', { data: new Uint8Array(0) }, new Uint8Array(0)),
    /detached byte buffer/,
  );
});

test('typed dispatch falls back to name-based invokeTyped without invokeTypedById (P0-3)', async () => {
  // 호환 계약: 구 네이티브는 invokeTypedById 미노출 — 기존 이름 기반 경로 유지.
  const calls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: (name) => {
      calls.push(`has:${name}`);
      return true;
    },
    invokeTyped: (name) => {
      calls.push(`typed:${name}`);
      return { value: 42 };
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    [
      'addNumbers',
      {
        commandId: 1,
        encode: () => new ArrayBuffer(4),
        decode: () => ({ ok: true, result: { value: 0 } }),
      },
    ],
  ]);
  const engine = createRkyvV2Engine(native, registry);
  const out = await engine.invoke<{ value: number }>('addNumbers', { a: 1, b: 2 });
  assert.equal(out.value, 42, 'fallback must resolve via name-based invokeTyped');
  assert.ok(calls.includes('typed:addNumbers'), 'invokeTyped must be called on fallback');
  // 캐시는 여전히 적용 — 두 번째 호출엔 hasStaticCodec 재호출 없음.
  await engine.invoke<{ value: number }>('addNumbers', { a: 2, b: 3 });
  assert.equal(calls.filter((c) => c.startsWith('has:')).length, 1);
});

test('dynamic command skips the static-id cache and stays on Tier 3 (P0-3)', async () => {
  // hasStaticCodec 이 false 인 이름(동적 명령)은 캐시 스윕에서 제외되고,
  // 이후 invoke 마다 재조사 없이 Tier 3 경로로 간다 — 캐시 미스가 안정적이어야
  // 매 호출 hasStaticCodec 을 되묻는 회귀가 없다.
  const calls: string[] = [];
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 7 }]),
    invokeImpl: () => tier3Success({ v: 7 }),
    hasStaticCodec: (name) => {
      calls.push(`has:${name}`);
      return name === 'addNumbers';
    },
    invokeTyped: () => {
      throw new Error('invokeTyped must not be called for dynamic commands');
    },
    invokeTypedById: () => {
      throw new Error('invokeTypedById must not be called for dynamic commands');
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    [
      'addNumbers',
      {
        commandId: 1,
        encode: () => new ArrayBuffer(4),
        decode: () => ({ ok: true, result: { value: 0 } }),
      },
    ],
  ]);
  const engine = createRkyvV2Engine(native, registry);
  const out = await engine.invoke<{ v: number }>('dyn', {});
  assert.equal(out.v, 7, 'dynamic command must resolve via Tier 3');
  await engine.invoke<{ v: number }>('dyn', {});
  // 스윕은 registry 키만 조사한다 — registry 에 없는 'dyn' 은 아예 프로브되지
  // 않는다(불변식: 정적 명령은 항상 registry 에 있다). 매 호출 hasStaticCodec
  // 을 되묻는 회귀가 없다는 것이 이 테스트의 핵심.
  const dynSweeps = calls.filter((c) => c === 'has:dyn').length;
  assert.equal(dynSweeps, 0, 'dynamic command must never be probed — not in the registry');
  assert.equal(
    calls.filter((c) => c === 'has:addNumbers').length,
    1,
    'initial sweep probes each registry entry exactly once',
  );
});

// ── createRkyvV2Engine: P0-2 invokeBatch (단일 횡단 배치) ────

test('invokeBatch uses single invokeTypedBatch when all entries are static (P0-2)', async () => {
  let batchCalls = 0;
  let singleCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: (name) => name === 'add' || name === 'mul',
    invokeTyped: () => {
      singleCalls++;
      return { value: 0 };
    },
    invokeTypedBatch: (names) => {
      batchCalls++;
      // 이름 순서대로 결과 반환 — 순서 보존 검증용.
      return names.map((n) => ({ value: n === 'add' ? 3 : 6 }));
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add', 'mul'));
  const out = await engine.invokeBatch<Array<{ value: number }>>([
    { command: 'add', args: { a: 1, b: 2 } },
    { command: 'mul', args: { a: 2, b: 3 } },
    { command: 'add', args: { a: 0, b: 0 } },
  ]);
  assert.equal(batchCalls, 1, 'invokeTypedBatch must be called exactly once');
  assert.equal(singleCalls, 0, 'per-entry invokeTyped must not run on batch path');
  assert.deepEqual(
    out,
    [{ value: 3 }, { value: 6 }, { value: 3 }],
    'batch results must preserve order',
  );
});

test('invokeBatch turns a synchronous native batch throw into a rejected Promise', async () => {
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => ({ value: 0 }),
    invokeTypedBatch: () => {
      throw new RustraCommandError('transport.error', 'batch transport failed', true);
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add'));
  const returned = engine.invokeBatch([{ command: 'add', args: {} }]);
  assert.equal(typeof returned.then, 'function');
  await assert.rejects(
    returned,
    (error: unknown) =>
      error instanceof RustraCommandError &&
      error.code === 'transport.error' &&
      error.retryable === true,
  );
});

test('invokeBatch falls back to per-entry invoke when dynamic commands are mixed', async () => {
  let batchCalls = 0;
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 9 }]),
    invokeImpl: (payload) => {
      const id = new DataView(payload).getUint16(0, true);
      return tier3Success({ v: id }); // 동적 명령 결과
    },
    hasStaticCodec: (name) => name === 'add',
    invokeTyped: () => ({ value: 42 }),
    invokeTypedBatch: () => {
      batchCalls++;
      return [];
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add'));
  const out = await engine.invokeBatch<Array<{ value: number } | { v: number }>>([
    { command: 'add', args: {} }, // 정적 → invokeTyped
    { command: 'dyn', args: {} }, // 동적 → Tier 3
  ]);
  assert.equal(batchCalls, 0, 'mixed batch must NOT use invokeTypedBatch');
  assert.deepEqual(out, [{ value: 42 }, { v: 9 }]);
});

// ── invokeBatch 항목별 취소 (T1 후속) ───────────────────────

test('invokeBatch entry signal routes the whole batch off the single crossing (T1 follow-up)', async () => {
  // signal 있는 항목이 하나라도 섞이면 단일 횡단(invokeTypedBatch)을 타지
  // 않고 Promise.all 폴백으로 간다 — 각 항목은 자기 취소 정책을 따른다.
  let batchCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: (name) => ({ echo: name }),
    invokeTypedBatch: () => {
      batchCalls++;
      return [];
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('a', 'b'));

  const ac = new AbortController();
  const p = engine.invokeBatch([
    { command: 'a', args: {} },
    { command: 'b', args: {}, options: { signal: ac.signal } },
  ]);
  ac.abort();

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError);
    assert.equal((err as RustraCommandError).code, 'cancelled');
    return true;
  });
  assert.equal(batchCalls, 0, 'signal entry must force the fallback routing');
});

test('invokeBatch signal-less static entries still use the single crossing (T1 follow-up)', async () => {
  // 옵션 필드가 있어도 signal 이 없으면 단일 횡단 유지 — 회귀 가드.
  let batchCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => ({ value: 0 }),
    invokeTypedBatch: (names) => {
      batchCalls++;
      return names.map(() => ({ value: 1 }));
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('a', 'b'));
  const out = await engine.invokeBatch<Array<{ value: number }>>([
    { command: 'a', args: {}, options: {} }, // options 있지만 signal 없음
    { command: 'b' }, // 기존 형태 그대로
  ]);
  assert.equal(batchCalls, 1, 'signal-less entries must keep the single crossing');
  assert.deepEqual(out, [{ value: 1 }, { value: 1 }]);
});

test('invokeBatch entry cancel only rejects that entry independently (T1 follow-up)', async () => {
  // 항목별 독립 취소 — signal 항목만 거부되고 다른 항목은 정상 완료… 는
  // Promise.all 전체 거부로 관찰된다. 각 항목 invoke 가 options 를 받았는지가
  // 이 테스트의 관심사다: pre-aborted signal 항목은 네이티브 호출 없이 거부.
  const typedCalls: string[] = [];
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: (name) => {
      typedCalls.push(name);
      return { echo: name };
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('a', 'b'));

  const ac = new AbortController();
  ac.abort(); // 사전 중단 — 'b' 는 절대 네이티브에 닿으면 안 된다.
  await assert.rejects(
    engine.invokeBatch([
      { command: 'a', args: {} },
      { command: 'b', args: {}, options: { signal: ac.signal } },
    ]),
    (err: unknown) =>
      err instanceof RustraCommandError && (err as RustraCommandError).code === 'cancelled',
  );
  // Promise.all 폴백에서 'a' 가 먼저 dispatch 될 수 있으나, pre-aborted 'b' 는
  // dispatch 되지 않는다. 'a' 호출 여부는 스케줄 순서와 무관하게 허용.
  assert.ok(!typedCalls.includes('b'), "pre-aborted entry 'b' must never reach the native layer");
});

test('invokeBatch without typed-batch native falls back to per-entry', async () => {
  // invokeTypedBatch 미제공 → hasBatchPath=false → 항목별 invoke.
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: (name) => ({ echo: name }),
  });
  const engine = createRkyvV2Engine(native, staticRegistry('a', 'b'));
  const out = await engine.invokeBatch<Array<{ echo: string }>>([
    { command: 'a', args: {} },
    { command: 'b', args: {} },
  ]);
  assert.deepEqual(out, [{ echo: 'a' }, { echo: 'b' }]);
});

// ── createRkyvV2Engine: P0-2 byId 배치 (invokeTypedBatchById) ──

test('invokeBatch uses invokeTypedBatchById with cmd_id array when available (P0-2 byId)', async () => {
  // byId 배치 진입: 모든 항목이 정적 캐시에 있으면 이름 배열 대신 cmd_id 배열로
  // 단일 횡단 — 문자열 마샬링 N 회 제거. 결과는 순서 보존.
  const batchByIdCalls: number[][] = [];
  let nameBatchCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: (name) => name === 'add' || name === 'mul',
    invokeTyped: () => ({ value: 0 }),
    invokeTypedBatch: () => {
      nameBatchCalls++;
      return [];
    },
    invokeTypedBatchById: (ids) => {
      batchByIdCalls.push([...ids]);
      // staticRegistry('add','mul') → cmdId 1, 2 — id 순서대로 결과 반환.
      return ids.map((id) => ({ value: id * 10 }));
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add', 'mul'));
  const out = await engine.invokeBatch<Array<{ value: number }>>([
    { command: 'add', args: { a: 1, b: 2 } }, // cmdId 1
    { command: 'mul', args: { a: 2, b: 3 } }, // cmdId 2
    { command: 'add', args: { a: 0, b: 0 } }, // cmdId 1 (중복 포함)
  ]);
  assert.equal(batchByIdCalls.length, 1, 'invokeTypedBatchById must be called exactly once');
  assert.deepEqual(
    batchByIdCalls[0],
    [1, 2, 1],
    'cmd_id array must follow entry order (duplicates preserved)',
  );
  assert.equal(nameBatchCalls, 0, 'name-based invokeTypedBatch must not run on byId path');
  assert.deepEqual(out, [{ value: 10 }, { value: 20 }, { value: 10 }], 'order preserved');
});

test('invokeBatch falls back to name-based invokeTypedBatch without invokeTypedBatchById (P0-2 byId)', async () => {
  // 호환 계약: 구 네이티브는 byId 배치 미노출 — 기존 이름 기반 경로 유지.
  let nameBatchCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => ({ value: 0 }), // hasTypedPath 충족용
    invokeTypedBatch: (names) => {
      nameBatchCalls++;
      return names.map((n) => ({ echo: n }));
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('a', 'b'));
  const out = await engine.invokeBatch<Array<{ echo: string }>>([
    { command: 'a', args: {} },
    { command: 'b', args: {} },
  ]);
  assert.equal(nameBatchCalls, 1, 'name-based invokeTypedBatch must remain the fallback');
  assert.deepEqual(out, [{ echo: 'a' }, { echo: 'b' }]);
});

test('invokeBatch skips invokeTypedBatchById when a cache-miss (dynamic) entry is mixed (P0-2 byId)', async () => {
  // 캐시 미스 항목(동적 명령)이 섞이면 byId 배열을 조립할 수 없다 —
  // 기존 폴백 경로(항목별 invoke)로 라우팅되고 byId/이름 배치 모두 미사용.
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 9 }]),
    invokeImpl: () => tier3Success({ v: 9 }),
    hasStaticCodec: (name) => name === 'add',
    invokeTyped: () => ({ value: 42 }),
    invokeTypedBatch: () => {
      throw new Error('invokeTypedBatch must not run for mixed batches');
    },
    invokeTypedBatchById: () => {
      throw new Error('invokeTypedBatchById must not run for mixed batches');
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add'));
  const out = await engine.invokeBatch<Array<{ value: number } | { v: number }>>([
    { command: 'add', args: {} }, // 정적 → invokeTyped
    { command: 'dyn', args: {} }, // 동적(캐시 미스) → Tier 3
  ]);
  assert.deepEqual(out, [{ value: 42 }, { v: 9 }]);
});

// ── Task 3.3: 동시성 / 배치 에러 전파 ──────────────────────
// echo 코덱 + 제어 가능한 mock native 로 JS codec 경로(경로 2)의 invoke/Batch 를
// 검증. failTags 에 해당하면 에러 프레임을 반환해 항목별 에러를 흉내낸다.
//   request  = [cmd 200 LE][tag][msg]
//   success  = [ok:1][7B 0][tag][msg]
//   error    = [ok:0][7B 0][code-len][code][msg]
type EchoOut = { tag: number; msg: string };

/** echo 코덱 (Task 3.3 / T1 공용). request [cmd 200 LE][tag][msg]. */
function echoCodec(): RkyvV2Codec<{ tag: number; msg: string }, EchoOut> {
  const enc = new TextEncoder();
  return {
    commandId: 200,
    encode(args) {
      const m = enc.encode(args.msg);
      const u = new Uint8Array(2 + 1 + m.length);
      u[0] = 0xc8;
      u[1] = 0x00;
      u[2] = args.tag & 0xff;
      u.set(m, 3);
      return u.buffer;
    },
    decode(frame) {
      const u =
        frame instanceof ArrayBuffer
          ? new Uint8Array(frame)
          : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
      if (u[0] === 1) {
        return {
          ok: true,
          result: { tag: u[8], msg: new TextDecoder().decode(u.slice(9)) },
        };
      }
      const codeLen = u[8];
      const code = new TextDecoder().decode(u.slice(9, 9 + codeLen));
      const message = new TextDecoder().decode(u.slice(9 + codeLen));
      return { ok: false, error: { code, message } };
    },
  };
}

function echoEngine(failTags: Set<number> = new Set()) {
  const enc = new TextEncoder();
  const codec = echoCodec();
  const native = makeNative({
    invokeImpl(payload) {
      const req = new Uint8Array(payload);
      const tag = req[2];
      if (failTags.has(tag)) {
        const codeB = enc.encode(`echo.fail.${tag}`);
        const msgB = enc.encode('boom');
        const body = [codeB.length, ...codeB, ...msgB];
        const fr = new Uint8Array(8 + body.length);
        fr[0] = 0;
        fr.set(body, 8);
        return fr.buffer;
      }
      const rb = req.slice(2); // [tag][msg]
      const fr = new Uint8Array(8 + rb.length);
      fr[0] = 1;
      fr.set(rb, 8);
      return fr.buffer;
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', codec as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  return createRkyvV2Engine(native, registry);
}

test('concurrent invokes do not cross-correlate (Task 3.3)', async () => {
  const engine = echoEngine();
  const N = 50;
  const entries = Array.from({ length: N }, (_, i) => ({ tag: i % 256, msg: `m${i}` }));
  // N 개 invoke 를 동시에 — 코덱/native 가 공유 상태를 쓰면 결과가 섞인다.
  const results = await Promise.all(entries.map((e) => engine.invoke<EchoOut>('echo', e)));
  assert.equal(results.length, N);
  for (let i = 0; i < N; i++) {
    assert.equal(results[i].tag, i % 256, `entry ${i} tag must match its own input`);
    assert.equal(results[i].msg, `m${i}`, `entry ${i} msg must match its own input`);
  }
});

test('invokeBatch fallback preserves entry order & distinctness (Task 3.3)', async () => {
  // invokeTypedBatch 미제공 → Promise.all(entries.map(invoke)) 폴백 경로.
  const engine = echoEngine();
  const entries: BatchEntry[] = Array.from({ length: 10 }, (_, i) => ({
    command: 'echo',
    args: { tag: i, msg: `b${i}` },
  }));
  const out = await engine.invokeBatch<EchoOut>(entries);
  assert.equal(out.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(out[i].tag, i, `batch item ${i} tag`);
    assert.equal(out[i].msg, `b${i}`, `batch item ${i} msg`);
  }
});

test('invokeBatch rejects with the failing entry error (Task 3.3)', async () => {
  // tag 3 이 에러 프레임을 반환 → Promise.all 이 해당 항목에서 reject.
  const engine = echoEngine(new Set([3]));
  const entries: BatchEntry[] = [
    { command: 'echo', args: { tag: 1, msg: 'a' } },
    { command: 'echo', args: { tag: 3, msg: 'boom' } },
    { command: 'echo', args: { tag: 5, msg: 'c' } },
  ];
  await assert.rejects(
    engine.invokeBatch(entries),
    (err: unknown) =>
      err instanceof RustraCommandError &&
      (err as RustraCommandError).code === 'echo.fail.3' &&
      /boom/.test((err as RustraCommandError).message),
  );
});

// ── Trust-test baseline (Phase 0) ───────────────────────────

test('F5: contractHash mismatch throws at engine creation (opt-in enforcement)', () => {
  // 옵션의 hash 와 네이티브 실시간 hash 가 다르면 엔진 생성 단계에서 즉시 실패한다.
  const native = makeNative({ contractHash: 'a'.repeat(64) });
  assert.throws(
    () => createRkyvV2Engine(native, new Map(), { contractHash: 'b'.repeat(64) }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError, 'must be RustraCommandError');
      assert.equal(
        (err as RustraCommandError).code,
        'contract.mismatch',
        'code must indicate schema drift',
      );
      assert.match((err as Error).message, /mismatch/);
      return true;
    },
  );
});

test('F5: matching contractHash creates the engine successfully', () => {
  const hash = 'c'.repeat(64);
  const native = makeNative({ contractHash: hash });
  const engine = createRkyvV2Engine(native, new Map(), { contractHash: hash });
  assert.ok(engine, 'matching hash must create the engine');
  assert.equal(typeof engine.invoke, 'function');
});

test('F5: contractHash option without native getContractHash throws contract.unenforceable', () => {
  // 옵션은 설정했으나 네이티브가 getContractHash 를 노출하지 않으면 검증 불가 → 명시적 에러.
  const native = makeNative({}); // contractHash undefined → getContractHash 미노출
  assert.throws(
    () => createRkyvV2Engine(native, new Map(), { contractHash: 'd'.repeat(64) }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'contract.unenforceable');
      return true;
    },
  );
});

test('F5: no contractHash option skips verification (backward compatible)', () => {
  // 옵션 미설정 시 검증하지 않는다 (기본값, 하위 호환).
  const engine = createRkyvV2Engine(makeNative({}), new Map());
  assert.ok(engine, 'engine created without any contract-hash argument');
  assert.equal(typeof engine.invoke, 'function', 'exposes invoke per EngineClient');
});

// ── T2 Task 9: onContractMismatch 옵트인 폴백 + schemaVersion stale 경고 ──

test('T2: mismatch + no callback still throws contract.mismatch (regression pin)', () => {
  // onContractMismatch 미설정 시 기존 fail-fast 동작이 그대로 유지되어야 한다.
  const native = makeNative({ contractHash: 'a'.repeat(64) });
  assert.throws(
    () => createRkyvV2Engine(native, new Map(), { contractHash: 'b'.repeat(64) }),
    (err: unknown) =>
      err instanceof RustraCommandError && (err as RustraCommandError).code === 'contract.mismatch',
  );
});

test('T2: mismatch + onContractMismatch creates degraded engine, callback sees both hashes', () => {
  const nativeHash = 'a'.repeat(64);
  const expectedHash = 'b'.repeat(64);
  const native = makeNative({ contractHash: nativeHash });
  const calls: Array<{ nativeHash: string; expectedHash: string }> = [];
  const engine = createRkyvV2Engine(native, new Map(), {
    contractHash: expectedHash,
    onContractMismatch: (info) => calls.push(info),
  });
  assert.ok(engine, 'degraded engine must still be created when callback is set');
  assert.equal(typeof engine.invoke, 'function');
  assert.equal(calls.length, 1, 'callback must be called exactly once');
  assert.equal(calls[0]?.nativeHash, nativeHash, 'callback must receive the native hash');
  assert.equal(calls[0]?.expectedHash, expectedHash, 'callback must receive the expected hash');
});

test('T2: unenforceable + onContractMismatch still throws (nothing to verify)', () => {
  // getContractHash 미노출 → native hash 를 알 방법이 없어 degraded 모드가
  // 무의미하다. 콜백 설정과 무관하게 항상 throw.
  const native = makeNative({}); // contractHash undefined → getContractHash 미노출
  assert.throws(
    () =>
      createRkyvV2Engine(native, new Map(), {
        contractHash: 'd'.repeat(64),
        onContractMismatch: () => {
          throw new Error('callback must not be invoked for unenforceable');
        },
      }),
    (err: unknown) =>
      err instanceof RustraCommandError &&
      (err as RustraCommandError).code === 'contract.unenforceable',
  );
});

// ── B4: mismatch 콜백 info 의 diagnosis 옵션 필드 ──
// 엔진은 mismatch 시점에 diff 를 계산할 live schema 만 있고 빌드 시점 스키마가
// 없어 diagnosis 를 채우지 않는다(undefined). 진단은 빌드 시점 schema.json 을
// 들고 있는 생산자(diffSchemas 등)가 채워 전달하는 구조적 계약이다.

test('B4: engine callback info leaves diagnosis undefined (additive contract)', () => {
  const nativeHash = 'a'.repeat(64);
  const native = makeNative({ contractHash: nativeHash });
  const calls: Array<{ nativeHash: string; expectedHash: string; diagnosis?: unknown }> = [];
  createRkyvV2Engine(native, new Map(), {
    contractHash: 'b'.repeat(64),
    onContractMismatch: (info) => calls.push(info),
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.diagnosis,
    undefined,
    'engine does not compute diffs; diagnosis stays undefined',
  );
});

test('B4: ContractMismatchDiagnosis round-trips as a plain object', () => {
  // 생산자가 diffSchemas 진단을 그대로 실어 보낼 수 있는지 (직렬화 가능 평이 객체).
  const diagnosis = {
    diagnoses: [
      {
        code: 'command_id_displaced' as const,
        command: 'add',
        oldId: 1,
        newId: 2,
        detail: "command 'add' kept its name but its command id changed from 1 to 2",
      },
    ],
  };
  const json = JSON.parse(JSON.stringify(diagnosis));
  assert.deepEqual(json, diagnosis);
  assert.equal(json.diagnoses[0].detail.includes('command id changed'), true);
});

test('T2: schemaVersion equal → no staleness warning', () => {
  const native = makeNative({ schema: schemaBytes([{ name: 'add', commandId: 1 }], 3) });
  const stale = mockSchemaStale();
  const engine = createRkyvV2Engine(native, new Map(), {
    schemaVersion: 3,
    onSchemaStale: stale.cb,
  });
  assert.ok(engine);
  assert.equal(stale.calls.length, 0, 'equal versions must not warn');
});

test('T2: schemaVersion JS < native → no warning (normal upgrade path)', () => {
  // 구 JS + 신 네이티브 — 신 기능은 못 써도 기존 동작은 정상인 조합.
  const native = makeNative({ schema: schemaBytes([{ name: 'add', commandId: 1 }], 5) });
  const stale = mockSchemaStale();
  const engine = createRkyvV2Engine(native, new Map(), {
    schemaVersion: 4,
    onSchemaStale: stale.cb,
  });
  assert.ok(engine);
  assert.equal(stale.calls.length, 0, 'JS < native must not warn');
});

test('T2: schemaVersion JS > native → onSchemaStale receives both versions', () => {
  // 신 JS + 구 네이티브 — OTA 롤백/지연 배포. fatal 아님: 경고만.
  const native = makeNative({ schema: schemaBytes([{ name: 'add', commandId: 1 }], 2) });
  const stale = mockSchemaStale();
  const engine = createRkyvV2Engine(native, new Map(), {
    schemaVersion: 4,
    onSchemaStale: stale.cb,
  });
  assert.ok(engine, 'staleness must never block engine creation');
  assert.equal(stale.calls.length, 1);
  assert.deepEqual(stale.calls[0], { nativeVersion: 2, jsVersion: 4 });
});

test('T2: schemaVersion JS > native without callback → console.warn fallback', () => {
  const native = makeNative({ schema: schemaBytes([{ name: 'add', commandId: 1 }], 1) });
  const warns = mockConsoleWarn();
  try {
    const engine = createRkyvV2Engine(native, new Map(), { schemaVersion: 2 });
    assert.ok(engine);
    assert.equal(warns.calls.length, 1, 'console.warn fallback must fire exactly once');
    assert.match(warns.calls[0] ?? '', /schema stale/);
    // 리뷰 Minor 2: 숫자만 매칭하면 "schemaVersion" 토큰의 우연한 등장과 구분되지
    // 않는다 — 키=값 쌍 전체로 매칭한다.
    assert.match(warns.calls[0] ?? '', /schemaVersion=2/);
    assert.match(warns.calls[0] ?? '', /schemaVersion=1/);
    assert.match(warns.calls[0] ?? '', /native/);
  } finally {
    warns.restore();
  }
});

test('T2: native schema without schemaVersion field defaults to 1 (old-native pin)', () => {
  // pre-Task-8 네이티브는 schemaVersion 필드가 없다 — CLI old-schema 관례대로
  // 1 로 취급. JS=1 이면 경고 없음, JS=2 면 경고.
  const oldNative = makeNative({ schema: schemaBytes([{ name: 'add', commandId: 1 }]) });
  const quiet = mockSchemaStale();
  createRkyvV2Engine(oldNative, new Map(), { schemaVersion: 1, onSchemaStale: quiet.cb });
  assert.equal(quiet.calls.length, 0, 'JS=1 vs old native (default 1) must not warn');

  const warned = mockSchemaStale();
  createRkyvV2Engine(oldNative, new Map(), { schemaVersion: 2, onSchemaStale: warned.cb });
  assert.equal(warned.calls.length, 1, 'JS=2 vs old native (default 1) must warn');
  assert.deepEqual(warned.calls[0], { nativeVersion: 1, jsVersion: 2 });
});

test('T2: schemaVersion option + native without getSchema → silent no-op', () => {
  // getSchema 미노출 구 네이티브 — 비교할 스키마가 없으므로 조용히 건너뛴다.
  const native = { invokeRkyvV2: () => new ArrayBuffer(0) } as RkyvV2SchemaNative;
  const stale = mockSchemaStale();
  const engine = createRkyvV2Engine(native, new Map(), {
    schemaVersion: 99,
    onSchemaStale: stale.cb,
  });
  assert.ok(engine, 'must not crash when getSchema is absent');
  assert.equal(stale.calls.length, 0, 'nothing to compare → no warning');
});

test('T2: garbage getSchema bytes + schemaVersion set → engine created, no throw, no warn', () => {
  // Task 9 리뷰 Important: staleness 검사가 생성 시점에 스키마를 무방비하게
  // 파싱해 malformed JSON 이 createRkyvV2Engine 밖으로 새어나갔다. "경고 기능은
  // 절대 치명적이지 않다" 계약의 위반 — 파싱 실패는 getSchema 미노출과 동일하게
  // 조용히 건너뛴다 (onSchemaStale 미발생, console.warn 미발생).
  const garbageNative = makeNative({ schema: bytesFromStrings(['<<<not json at all>>>']) });
  const stale = mockSchemaStale();
  const warns = mockConsoleWarn();
  try {
    const engine = createRkyvV2Engine(garbageNative, new Map(), {
      schemaVersion: 2,
      onSchemaStale: stale.cb,
    });
    assert.ok(engine, 'malformed getSchema must never block engine creation');
    assert.equal(stale.calls.length, 0, 'unparseable schema → nothing to compare');
    assert.equal(warns.calls.length, 0, 'silent skip — no console.warn either');
  } finally {
    warns.restore();
  }
});

test('T2: schemaVersion as string in schema JSON → treated as absent, defaults to 1', () => {
  // Task 9 리뷰 Minor 4: parseLiveSchemaDocument 는 유한 number 인 경우에만
  // schemaVersion 을 채운다. 문자열 "2" 는 absent 와 같다 — 기본 1 로 취급해
  // JS=1 이면 경고 없음, JS=2 면 nativeVersion=1 경고.
  const stringVersionDoc = JSON.stringify({
    packageId: 't',
    schemaVersion: '2',
    commands: [{ name: 'add', commandId: 1 }],
  });
  const native = makeNative({ schema: bytesFromStrings([stringVersionDoc]) });
  const quiet = mockSchemaStale();
  createRkyvV2Engine(native, new Map(), { schemaVersion: 1, onSchemaStale: quiet.cb });
  assert.equal(quiet.calls.length, 0, 'JS=1 vs string-version native (default 1) must not warn');

  const warned = mockSchemaStale();
  createRkyvV2Engine(native, new Map(), { schemaVersion: 2, onSchemaStale: warned.cb });
  assert.equal(warned.calls.length, 1, 'JS=2 vs string-version native must warn against default 1');
  assert.deepEqual(warned.calls[0], { nativeVersion: 1, jsVersion: 2 });
});

/** onSchemaStale 호출 기록용 마이크로 헬퍼 (T2). */
function mockSchemaStale(): {
  calls: Array<{ nativeVersion: number; jsVersion: number }>;
  cb: (info: { nativeVersion: number; jsVersion: number }) => void;
} {
  const calls: Array<{ nativeVersion: number; jsVersion: number }> = [];
  return { calls, cb: (info) => calls.push(info) };
}

/** console.warn 교체 헬퍼 — 복원은 반드시 restore() 로 (T2). */
function mockConsoleWarn(): { calls: string[]; restore(): void } {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
}

// ── parseRustraErrorString (F4 — JSON fallback code/message 파싱) ──

test('parseRustraErrorString splits "code: message" into RustraCommandError', () => {
  const err = parseRustraErrorString('command.not_found: command not found: add');
  assert.ok(err instanceof RustraCommandError);
  assert.equal(err.code, 'command.not_found');
  // message 자체에 ": " 가 있어도 첫 구분자만 사용한다.
  assert.equal(err.message, 'command not found: add');
});

test('parseRustraErrorString handles dotless code (internal)', () => {
  const err = parseRustraErrorString('internal: serde explode');
  assert.equal(err.code, 'internal');
  assert.equal(err.message, 'serde explode');
});

test('parseRustraErrorString falls back to invoke.failed for non-code strings', () => {
  // FFI 수준 에러 — code 토큰이 아님(공백 포함 / 구분자 없음).
  const a = parseRustraErrorString('json decode failed: eof');
  assert.equal(a.code, 'invoke.failed');
  assert.equal(a.message, 'json decode failed: eof');
  const b = parseRustraErrorString('payload exceeds size limit');
  assert.equal(b.code, 'invoke.failed');
  const c = parseRustraErrorString(undefined);
  assert.equal(c.code, 'invoke.failed');
  assert.equal(c.message, 'Rustra invoke failed');
});

test('parseRustraErrorString restores payload.too_large from unified Rust code (T3 follow-up)', () => {
  // Rust FFI 게이트가 이제 RustraError::payload_too_large Display 형태를
  // 반환한다 — JS 사전 검사와 동일 원인이 같은 코드로 복원되어야 한다
  // (예전 평문 "payload exceeds size limit" → invoke.failed 강등 회귀 방지).
  const err = parseRustraErrorString(
    'payload.too_large: payload 1048577B exceeds max payload 1048576B',
  );
  assert.ok(err instanceof RustraCommandError);
  assert.equal(err.code, 'payload.too_large');
  assert.equal(err.message, 'payload 1048577B exceeds max payload 1048576B');
  assert.equal(err.retryable, false, 'payload.too_large is deterministic, not retryable');
});

test('parseRustraErrorString parses JSON error objects and respects retryable', () => {
  const jsonErr = JSON.stringify({
    code: 'database.unavailable',
    message: 'Connection pool exhausted',
    retryable: true,
  });
  const err = parseRustraErrorString(jsonErr);
  assert.ok(err instanceof RustraCommandError);
  assert.equal(err.code, 'database.unavailable');
  assert.equal(err.message, 'Connection pool exhausted');
  assert.equal(err.retryable, true);
});

test('normalizeRustraError preserves retryable metadata from string rejections', () => {
  const err = normalizeRustraError(
    '{"code":"transport.timeout","message":"request timed out","retryable":true}',
  );
  assert.equal(err.code, 'transport.timeout');
  assert.equal(err.message, 'request timed out');
  assert.equal(err.retryable, true);
});

test('normalizeRustraError preserves the original cause and stack', () => {
  const original = new Error('native failure');
  const normalized = normalizeRustraError(original);
  assert.equal(normalized.cause, original);
  assert.equal(normalized.stack, original.stack);
});

test('timeout and cancel codes normalize into dedicated error subclasses', () => {
  const timeout = normalizeRustraError({
    code: 'transport.timeout',
    message: 'request timed out',
  });
  assert.ok(timeout instanceof TimeoutError);
  assert.ok(timeout instanceof RustraCommandError);
  assert.equal(timeout.code, 'transport.timeout');
  assert.equal(timeout.retryable, true);

  const cancelled = normalizeRustraError({ code: 'cancelled', message: 'aborted by host' });
  assert.ok(cancelled instanceof CancelledError);
  assert.ok(cancelled instanceof RustraCommandError);
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(cancelled.retryable, true);

  const ordinary = normalizeRustraError({ code: 'internal', message: 'boom' });
  assert.ok(!(ordinary instanceof TimeoutError));
  assert.ok(!(ordinary instanceof CancelledError));
  assert.ok(ordinary instanceof RustraCommandError);
});

test('TimeoutError and CancelledError constructors keep code mapping and cause', () => {
  const cause = new Error('slow backend');
  const timeout = new TimeoutError('took too long', cause);
  assert.equal(timeout.code, 'transport.timeout');
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.cause, cause);
  assert.equal(timeout.name, 'TimeoutError');

  const cancelled = new CancelledError('aborted');
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(cancelled.retryable, true);
  assert.equal(cancelled.name, 'CancelledError');
});

test('Display-string rejections keep the flat RustraCommandError contract', () => {
  // 문자열 경로는 기존 평탄화 계약을 유지한다 — 서브클래스 승격은 구조화
  // {code, message} 경로에서만 일어난다(와이어 정합 영향 최소화).
  const parsed = normalizeRustraError('transport.timeout: request timed out');
  assert.equal(parsed.code, 'transport.timeout');
  assert.ok(parsed instanceof RustraCommandError);
  assert.ok(!(parsed instanceof TimeoutError));
});

test('opt-in debug sink receives bounded wire previews', () => {
  const events: Array<{ bytes?: string; byteLength?: number }> = [];
  configureDebug((event) => events.push({ bytes: event.bytes, byteLength: event.byteLength }));
  try {
    debugWire('request', 'rkyv', 'echo', new Uint8Array([0, 1, 255]).buffer);
    assert.deepEqual(events, [{ bytes: '0001ff', byteLength: 3 }]);
  } finally {
    configureDebug(undefined);
  }
});

// ── T1: AbortSignal 배선 ────────────────────────────────────

test('invoke without signal never calls invokeCancel (T1)', async () => {
  let cancels = 0;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 1 }]),
    invokeImpl: () => tier3Success({ value: 1 }),
  });
  (native as { invokeCancel?: () => boolean }).invokeCancel = () => {
    cancels++;
    return false;
  };
  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke('dyn', { a: 1 }); // tier3 dynamic path via getSchema
  assert.equal(cancels, 0);
});

test('pre-aborted signal rejects immediately without native call (T1)', async () => {
  let calls = 0;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 1 }]),
    invokeImpl: () => {
      calls++;
      return tier3Success({});
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(engine.invoke('dyn', {}, { signal: ac.signal }), (e: unknown) => {
    assert.ok(e instanceof RustraCommandError);
    assert.equal((e as RustraCommandError).code, 'cancelled');
    assert.equal((e as RustraCommandError).retryable, true);
    return true;
  });
  assert.equal(calls, 0, 'native must not be called');
});

test('abort mid-flight: shallow path rejects with cancelled (T1)', async () => {
  // invokeAsync 미노출 → 얕은 취소. native 는 동기 호출로 즉시 응답하지만
  // abort 가 dispatch 후 프라미스 settle 전에 개입하면 reject 가 이긴다.
  let calls = 0;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 1 }]),
    invokeImpl: () => {
      calls++;
      return tier3Success({ ok: true });
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  const p = engine.invoke('dyn', {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  // 얕은 취소는 JS 프라미스만 거부한다 — dispatch 는 이미 동기적으로 일어났다.
  assert.equal(calls, 1, 'shallow cancel must still have dispatched the native call');
});

test('typed-path command falls back to shallow cancel even with invokeAsync exposed (T1)', async () => {
  // tier 게이팅: invokeAsync/invokeCancel 이 노출돼 있어도 typed(tier 1)
  // 명령은 전파 대상이 아니다 — 얕은 취소, invokeCancel 미호출.
  let cancels = 0;
  let asyncCalls = 0;
  let typedCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => {
      typedCalls++;
      return { value: 7 };
    },
  });
  native.invokeAsync = () => {
    asyncCalls++;
    return 1;
  };
  native.invokeCancel = () => {
    cancels++;
    return true;
  };
  // registry 에 코덱이 있어도 B1 typed path 가 우선한다.
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController();
  const p = engine.invoke<{ value: number }>('echo', { tag: 1, msg: 'm' }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  assert.equal(typedCalls, 1, 'typed path must have been dispatched (shallow cancel)');
  assert.equal(asyncCalls, 0, 'invokeAsync must not be used for typed-path commands');
  assert.equal(cancels, 0, 'invokeCancel must not be called on shallow fallback');
});

test('tier3 dynamic command propagates cancel via invokeAsync (semantic closure)', async () => {
  // (의미론 마감) 코덱 없는 동적(tier 3) 명령도 invokeAsync+invokeCancel 노출 시
  // live schema 의 commandId 로 Tier 3 프레임을 invokeAsync 에 실어 전파한다.
  let cancels = 0;
  let asyncCalls = 0;
  let forwardedPayload: ArrayBuffer | undefined;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 3 }]),
    invokeImpl: () => tier3Success({ v: 1 }),
  });
  native.invokeAsync = (payload: ArrayBuffer, _cb: (resp: ArrayBuffer) => void) => {
    asyncCalls++;
    forwardedPayload = payload;
    return 11;
  };
  native.invokeCancel = () => {
    cancels++;
    return true;
  };
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  const p = engine.invoke<{ v: number }>('dyn', { x: 1 }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  assert.equal(asyncCalls, 1, 'invokeAsync must carry the tier3 request for dynamic commands');
  assert.ok(forwardedPayload !== undefined && forwardedPayload.byteLength >= 2, 'tier3 frame sent');
  // cmd_id = 3 (u16 LE) 프리앰블 검증
  const u8 = new Uint8Array(forwardedPayload!);
  assert.equal(u8[0] | (u8[1] << 8), 3, 'tier3 frame must carry live-schema commandId');
  assert.equal(cancels, 1, 'invokeCancel must reach the Rust checkpoint');
});

test('abort mid-flight: propagate path calls invokeCancel and rejects (T1)', async () => {
  // JS 코덱 경로 + invokeAsync/invokeCancel 노출 → 전파.
  // invokeAsync 는 id 만 반환하고 콜백을 즉시 부르지 않는다 (abort 가 먼저).
  const native = makeNative({});
  let cancelled = false;
  let forwardedId = -1;
  native.invokeAsync = (_payload: ArrayBuffer, _cb: (resp: ArrayBuffer) => void) => {
    return 77; // invocation id — 콜백 보류 (실 호스트는 워커 완료 시 호출)
  };
  native.invokeCancel = (id: number) => {
    forwardedId = id;
    cancelled = true;
    return true;
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController();
  const p = engine.invoke<EchoOut>('echo', { tag: 1, msg: 'm' }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError);
    assert.equal((e as RustraCommandError).code, 'cancelled');
    assert.equal((e as RustraCommandError).retryable, true);
    return true;
  });
  assert.equal(cancelled, true, 'invokeCancel must be called on the propagate path');
  assert.equal(forwardedId, 77, 'invokeCancel must receive the id invokeAsync returned');
});

test('late invokeAsync delivery after abort is ignored (T1)', async () => {
  // 협력적 취소 계약: abort 로 정착된 뒤 도착하는 정상 응답 프레임은 무시된다.
  // decode 가 실행조차 되지 않음을 sentinel 로 증명 (settled 가드 검증).
  const native = makeNative({});
  let cancelledId: number | null = null;
  let deliver: ((resp: ArrayBuffer) => void) | null = null;
  native.invokeAsync = (_payload: ArrayBuffer, cb: (resp: ArrayBuffer) => void) => {
    deliver = cb; // 콜백 보류 — abort 이후 수동 전달
    return 42;
  };
  native.invokeCancel = (id: number) => {
    cancelledId = id;
    return true;
  };
  const base = echoCodec();
  let decodeCalls = 0;
  const codec: RkyvV2Codec<unknown, unknown> = {
    commandId: base.commandId,
    encode: base.encode,
    decode: (_frame: ArrayBuffer) => {
      decodeCalls++;
      throw new Error('decode must not run after abort'); // sentinel
    },
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['echo', codec]]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController();
  const p = engine.invoke<EchoOut>('echo', { tag: 1, msg: 'm' }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  // abort 이후 유효한 성공 프레임이 늦게 도착해도 무시되어야 한다.
  const fr = new Uint8Array(10);
  fr[0] = 1;
  fr[8] = 1;
  deliver!(fr.buffer);
  await new Promise<void>((r) => queueMicrotask(() => r()));
  assert.equal(cancelledId, 42, 'invokeCancel must have been called with the invocation id');
  assert.equal(decodeCalls, 0, 'late delivery must not run decode (settled guard)');
});

test('propagate path settles when codec.decode throws on a malformed frame (T1)', async () => {
  // 잘못된 프레임으로 decode 가 throw 해도 예외가 네이티브 트램펄린으로
  // 새어나가 영원히 대기하는 일이 없어야 한다 — reject 로 정착한다.
  const native = makeNative({});
  native.invokeAsync = (_payload: ArrayBuffer, cb: (resp: ArrayBuffer) => void) => {
    queueMicrotask(() => cb(new ArrayBuffer(0))); // decode 가 throw 할 프레임
    return 1;
  };
  native.invokeCancel = () => true;
  const base = echoCodec();
  const codec: RkyvV2Codec<unknown, unknown> = {
    commandId: base.commandId,
    encode: base.encode,
    decode: () => {
      throw new Error('malformed frame');
    },
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['echo', codec]]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController();
  await assert.rejects(
    engine.invoke<EchoOut>('echo', { tag: 1, msg: 'm' }, { signal: ac.signal }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as Error).message, 'malformed frame');
      return true;
    },
  );
});

test('propagate executor cleans up abort listener on synchronous throw (T1)', async () => {
  // encode 가 동기 throw 하면 프라미스는 그 예외로 reject 되고, signal 의
  // abort 리스너는 제거되어야 한다 — 늦은 abort 가 invokeCancel 을 부르지 않는다.
  const native = makeNative({});
  let cancels = 0;
  native.invokeAsync = () => 1; // encode 가 먼저 throw 하므로 도달하지 않는다
  native.invokeCancel = () => {
    cancels++;
    return true;
  };
  const base = echoCodec();
  const codec: RkyvV2Codec<unknown, unknown> = {
    commandId: base.commandId,
    encode: () => {
      throw new Error('encode exploded');
    },
    decode: base.decode,
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['echo', codec]]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController();
  await assert.rejects(
    engine.invoke<EchoOut>('echo', { tag: 1, msg: 'm' }, { signal: ac.signal }),
    (e: unknown) => {
      assert.ok(e instanceof Error && (e as Error).message === 'encode exploded');
      return true;
    },
  );
  ac.abort(); // 리스너가 남아 있다면 invokeCancel 이 불릴 것이다
  await new Promise<void>((r) => queueMicrotask(() => r()));
  assert.equal(cancels, 0, 'leaked abort listener must not call invokeCancel');
});

test('propagate path resolves normally when invokeAsync completes first (T1)', async () => {
  // abort 없이 invokeAsync 콜백이 도착하면 tier2 와 동일하게 resolve.
  const native = makeNative({});
  native.invokeAsync = (_payload: ArrayBuffer, cb: (resp: ArrayBuffer) => void) => {
    // echo 성공 프레임: [ok:1][7B 0][tag][msg]
    const body = new TextEncoder().encode('late');
    const fr = new Uint8Array(8 + 1 + body.length);
    fr[0] = 1;
    fr[8] = 5;
    fr.set(body, 9);
    queueMicrotask(() => cb(fr.buffer));
    return 1;
  };
  native.invokeCancel = () => true; // 전파 경로 진입 조건 (호출되지 않음)
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry);
  const ac = new AbortController(); // abort 하지 않는 신호 — 전파 경로 유지
  const out = await engine.invoke<EchoOut>('echo', { tag: 5, msg: 'late' }, { signal: ac.signal });
  assert.equal(out.tag, 5);
  assert.equal(out.msg, 'late');
});

test('cancelled code is retryable via RustraCommandError default (T1)', () => {
  const e = parseRustraErrorString('cancelled: invocation cancelled before dispatch');
  assert.equal(e.code, 'cancelled');
  assert.equal(e.retryable, true); // isRetryableCode 미러링 검증
});

// ── T1 Task 6: 글로벌 invoke 옵션 전달 ──────────────────────

test('global invoke forwards options (signal) to engine invoke (T1)', async () => {
  // mock 엔진이 세 번째 인자(options)를 그대로 받는지 — signal 객체 동일성으로.
  const ac = new AbortController();
  const captured: { args?: unknown; options?: unknown } = {};
  const mockEngine = {
    invoke<T>(_command: string, args?: unknown, options?: unknown): Promise<T> {
      captured.args = args;
      captured.options = options;
      return Promise.resolve({ value: 1 } as T);
    },
  };
  // 센티넬: 이 테스트가 실패로 끝나도 mock 이 글로벌 엔진에 남아 이후
  // 테스트를 오염시키지 않게 finally 로 원복 — 호출되면 즉시 던진다.
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(mockEngine as EngineClient);
  try {
    const out = await invoke<{ value: number }>('dyn', { a: 1 }, { signal: ac.signal });
    assert.equal(out.value, 1);
    assert.deepEqual(captured.args, { a: 1 }, 'args must pass through unchanged');
    const opts = captured.options as { signal?: AbortSignal } | undefined;
    assert.ok(opts, 'options object must be forwarded to engine.invoke');
    assert.equal(opts?.signal, ac.signal, 'signal identity must pass through untouched');
  } finally {
    configure(sentinel);
  }
});

test('global invokeGenerated forwards the generated id to capable engines', async () => {
  const captured: { id?: number; command?: string; args?: unknown } = {};
  const mockEngine: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('name fallback must not run');
    },
    invokeById<T>(commandId: number, command: string, args?: unknown): Promise<T> {
      captured.id = commandId;
      captured.command = command;
      captured.args = args;
      return Promise.resolve({ value: 42 } as T);
    },
  };
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  };
  configure(mockEngine);
  try {
    const out = await invokeGenerated<{ value: number }>(23, 'benchAdd', { a: 20, b: 22 });
    assert.equal(out.value, 42);
    assert.deepEqual(captured, { id: 23, command: 'benchAdd', args: { a: 20, b: 22 } });
  } finally {
    configure(sentinel);
  }
});

test('global invokeGenerated uses one-Promise sync route for rustra engines', async () => {
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => {
      throw new Error('name dispatch must not run');
    },
    invokeTypedById: (id) => ({ value: id }),
  });
  const engine = createRkyvV2Engine(native, staticRegistry('benchAdd'));
  const publicInvokeById = engine.invokeById;
  engine.invokeById = () => {
    throw new Error('public Promise wrapper must be bypassed without options');
  };
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  };
  configure(engine);
  try {
    const pending = invokeGenerated<{ value: number }>(1, 'benchAdd', { a: 20, b: 22 });
    assert.ok(pending instanceof Promise, 'public generated command must still return a Promise');
    assert.deepEqual(await pending, { value: 1 });

    engine.invokeById = publicInvokeById;
    const withOptions = await invokeGenerated<{ value: number }>(1, 'benchAdd', {}, {});
    assert.deepEqual(withOptions, { value: 1 }, 'options path must retain public invokeById logic');
  } finally {
    configure(sentinel);
  }
});

test('global invokeGenerated falls back to invoke for legacy engines', async () => {
  let called = '';
  const legacy: EngineClient = {
    invoke<T>(command: string): Promise<T> {
      called = command;
      return Promise.resolve({ value: 3 } as T);
    },
  };
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  };
  configure(legacy);
  try {
    const out = await invokeGenerated<{ value: number }>(1, 'addNumbers', {});
    assert.equal(out.value, 3);
    assert.equal(called, 'addNumbers');
  } finally {
    configure(sentinel);
  }
});

// ── T3 Task 11: maxPayloadBytes JS 사전 검사 ────────────────
// 인코딩 직후/네이티브 호출 전 크기 검사. tier 2(JS codec)·tier 3(동적)·
// 전파(invokeAsync) 경로에 적용되고 typed(tier 1) 경로는 JS 측 인코딩이
// 없어 건너뛴다 — 미설정 시 아무 검사도 하지 않는다 (네이티브가 최종 게이트).

test('T3: over-limit tier-2 payload rejects payload.too_large without native call', async () => {
  let invokes = 0;
  const native = makeNative({
    invokeImpl: () => {
      invokes++;
      return new ArrayBuffer(0);
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry, { maxPayloadBytes: 8 });
  // echoCodec 인코딩: 2(cmd) + 1(tag) + msg — 'way over the limit' → 21B > 8B.
  await assert.rejects(
    engine.invoke<EchoOut>('echo', { tag: 1, msg: 'way over the limit' }),
    (e: unknown) => {
      assert.ok(e instanceof RustraCommandError, 'must be RustraCommandError');
      assert.equal((e as RustraCommandError).code, 'payload.too_large');
      assert.equal((e as RustraCommandError).retryable, false, 'deterministic client condition');
      return true;
    },
  );
  assert.equal(invokes, 0, 'invokeRkyvV2 must NEVER be called for over-limit payloads');
});

test('T3: within-limit tier-2 payload dispatches normally (control)', async () => {
  // echoEngine 패턴 재사용 — 한도 이내면 기존 dispatch 가 그대로 동작한다.
  const native = makeNative({
    invokeImpl: (payload) => {
      const req = new Uint8Array(payload);
      const rb = req.slice(2);
      const fr = new Uint8Array(8 + rb.length);
      fr[0] = 1;
      fr.set(rb, 8);
      return fr.buffer;
    },
  });
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry, { maxPayloadBytes: 8 });
  // 'abc' → 2 + 1 + 3 = 6B ≤ 8B.
  const out = await engine.invoke<EchoOut>('echo', { tag: 2, msg: 'abc' });
  assert.equal(out.tag, 2);
  assert.equal(out.msg, 'abc');
});

test('T3: over-limit tier-3 dynamic payload rejects before native call', async () => {
  let invokes = 0;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 1 }]),
    invokeImpl: () => {
      invokes++;
      return tier3Success({});
    },
  });
  const engine = createRkyvV2Engine(native, new Map(), { maxPayloadBytes: 8 });
  // tier3 요청: 2(cmd_id) + JSON 본체 — 이 인자면 훨씬 8B 를 넘는다.
  await assert.rejects(engine.invoke('dyn', { padding: '0123456789abcdef' }), (e: unknown) => {
    assert.ok(e instanceof RustraCommandError);
    assert.equal((e as RustraCommandError).code, 'payload.too_large');
    return true;
  });
  assert.equal(invokes, 0, 'tier-3 must reject before invokeRkyvV2');
});

test('T3: within-limit tier-3 dynamic payload dispatches normally (control)', async () => {
  // tier-2 컨트롤의 미러 — 한도 이내의 동적 명령 페이로드는 기존 tier-3 dispatch
  // 가 그대로 동작한다 (검사가 정상 경로를 우연히 깨지 않았는지 고정).
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 7 }]),
    invokeImpl: (payload) => {
      const id = new DataView(payload).getUint16(0, true);
      return tier3Success({ echoId: id });
    },
  });
  const engine = createRkyvV2Engine(native, new Map(), { maxPayloadBytes: 32 });
  // tier3 요청: 2(cmd_id) + JSON 본체('{"v":1}' 6B) = 8B ≤ 32B.
  const out = await engine.invoke<{ echoId: number }>('dyn', { v: 1 });
  assert.equal(out.echoId, 7, 'tier-3 control must reach native and round-trip');
});

test('T3: typed (tier 1) path skips the pre-check — invokeTyped still called', async () => {
  // tier 1 은 raw args 를 C++ 가 받아 인코딩한다 — JS 측에 잴 바이트가 없어
  // 검사를 건너뛴다 (설계 문서화). invokeTyped 는 그대로 호출되어야 한다.
  let typedCalls = 0;
  const native = makeTypedNative({
    hasStaticCodec: () => true,
    invokeTyped: () => {
      typedCalls++;
      return { value: 42 };
    },
  });
  const engine = createRkyvV2Engine(native, staticRegistry('add'), { maxPayloadBytes: 8 });
  const out = await engine.invoke<{ value: number }>('add', { big: 'x'.repeat(64) });
  assert.equal(out.value, 42);
  assert.equal(typedCalls, 1, 'typed path must NOT be gated by maxPayloadBytes');
});

test('T3: over-limit payload on propagate path rejects, invokeAsync never called', async () => {
  // 전파 경로(invokeAsync 배선)도 인코딩 직후 검사 — 네이티브 비동기 왕복 전에.
  const native = makeNative({});
  let asyncCalls = 0;
  native.invokeAsync = () => {
    asyncCalls++;
    return 1;
  };
  native.invokeCancel = () => true;
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry, { maxPayloadBytes: 8 });
  const ac = new AbortController(); // abort 하지 않는 신호 — 전파 경로 유지
  // catch 경로 정리를 스파이로 직접 증명 — 늦은 abort + invokeCancel 부재로는
  // "리스너가 아예 등록 안 됐다"는 변이와 구별되지 않는다(vacuous).
  let removes = 0;
  const orig = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.removeEventListener = (...args: Parameters<typeof orig>) => {
    removes++;
    return orig(...args);
  };
  await assert.rejects(
    engine.invoke<EchoOut>('echo', { tag: 1, msg: 'way over the limit' }, { signal: ac.signal }),
    (e: unknown) => {
      assert.ok(e instanceof RustraCommandError);
      assert.equal((e as RustraCommandError).code, 'payload.too_large');
      return true;
    },
  );
  assert.equal(asyncCalls, 0, 'invokeAsync must never receive an over-limit payload');
  assert.equal(removes, 1, 'catch-path cleanup must call removeEventListener exactly once');
});

test('T3: payload.too_large message carries both actual and limit byte sizes', async () => {
  const native = makeNative({});
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([
    ['echo', echoCodec() as unknown as RkyvV2Codec<unknown, unknown>],
  ]);
  const engine = createRkyvV2Engine(native, registry, { maxPayloadBytes: 8 });
  await assert.rejects(
    engine.invoke<EchoOut>('echo', { tag: 1, msg: 'way over the limit' }),
    (e: unknown) => {
      assert.ok(e instanceof RustraCommandError);
      // echoCodec('way over the limit') = 2(cmd) + 1(tag) + 18(msg) = 21B.
      assert.match((e as Error).message, /21B/);
      assert.match((e as Error).message, /8B/);
      return true;
    },
  );
});

// ── (의미론 마감) 3-tier × 취소 전파 매트릭스 ────────────────

test('typed(tier 1) command propagates cancel via invokeAsync when codec is absent', async () => {
  // typed 캐시에 있는 명령이더라도 registry 코덱이 없으면(JS 코드젠 제외 등)
  // Tier 3 프레임 + invokeAsync 로 전파 — 과거 얕은 취소 폴백을 확장.
  let cancels = 0;
  let asyncCalls = 0;
  let forwarded: ArrayBuffer | undefined;
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'typedCmd', commandId: 7 }]),
    invokeImpl: () => tier3Success({ ok: true }),
    hasStaticCodec: (name) => name === 'typedCmd',
    invokeTyped: () => ({ ok: true }),
  });
  native.invokeAsync = (payload: ArrayBuffer, _cb: (resp: ArrayBuffer) => void) => {
    asyncCalls++;
    forwarded = payload;
    return 21;
  };
  native.invokeCancel = () => {
    cancels++;
    return true;
  };
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  const p = engine.invoke<{ ok: boolean }>('typedCmd', {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  assert.equal(asyncCalls, 1);
  const u8 = forwarded ? new Uint8Array(forwarded) : new Uint8Array(0);
  assert.equal(u8[0] | (u8[1] << 8), 7, 'typed-cache commandId must ride the tier3 frame');
  assert.equal(cancels, 1);
});

test('dynamic command without live schema keeps shallow cancel (no commandId source)', async () => {
  // getSchema 미노출 + 코덱 없음 → commandId 를 알 수 없어 전파 불가 — 얕은 취소 유지.
  let asyncCalls = 0;
  const native = makeNative({ invokeImpl: () => tier3Success({ v: 1 }) });
  native.getSchema = undefined;
  native.invokeAsync = () => {
    asyncCalls++;
    return 1;
  };
  native.invokeCancel = () => true;
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  const p = engine.invoke<{ v: number }>('ghost', {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  assert.equal(asyncCalls, 0, 'no commandId source → invokeAsync must not be used');
});

// ── InvokeOptions.timeoutMs — transport.timeout 타임아웃 레이스 ──
// 네이티브가 응답하지 않는 hang(워커 패닉, FFI 데드락)의 JS 측 유일한 탈출구.
// Rust RustraError::timeout(retryable)과 같은 코드/재시도 의미론.

test('invoke with timeoutMs rejects transport.timeout when engine never settles', async () => {
  const hanging: EngineClient = { invoke: () => new Promise(() => {}) };
  await assert.rejects(
    invokeWithTimeout(hanging, 'addNumbers', { a: 1 }, { timeoutMs: 50 }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.timeout');
      assert.equal((err as RustraCommandError).retryable, true);
      return true;
    },
  );
});

test('timeout race ignores late result without unhandled rejection', async () => {
  let resolveLate!: (v: unknown) => void;
  const slow: EngineClient = {
    invoke: () =>
      new Promise((res) => {
        resolveLate = res as (v: unknown) => void;
      }),
  };
  await assert.rejects(
    invokeWithTimeout(slow, 'x', undefined, { timeoutMs: 30 }),
    /transport\.timeout|timed out/,
  );
  resolveLate(1); // 지각 도착 — 흡수되어야 함
  await new Promise((r) => setTimeout(r, 20)); // unhandled rejection 이 여기서 터지면 테스트 프로세스가 죽는다
});

test('RkyvV2 engine applies timeoutMs to an async native dispatch', async () => {
  const native = makeNative({ schema: schemaBytes([{ name: 'slow', commandId: 7 }]) });
  native.invokeAsync = () => 77; // callback intentionally never arrives
  native.invokeCancel = () => true;
  const codec: RkyvV2Codec<unknown, unknown> = {
    commandId: 7,
    encode: () => new ArrayBuffer(2),
    decode: () => ({ ok: true, result: {} }),
  };
  const engine = createRkyvV2Engine(native, new Map([['slow', codec]]));
  const controller = new AbortController();
  await assert.rejects(
    engine.invoke('slow', {}, { signal: controller.signal, timeoutMs: 10 }),
    (error: unknown) =>
      error instanceof RustraCommandError &&
      error.code === 'transport.timeout' &&
      error.retryable === true,
  );
});

test('invokeWithTimeout rejects a pending call when its signal aborts', async () => {
  let resolveLate!: (value: number) => void;
  const pending: EngineClient = {
    invoke: <T>() =>
      new Promise<T>((resolve) => {
        resolveLate = (value) => resolve(value as T);
      }),
  };
  const controller = new AbortController();
  const returned = invokeWithTimeout(pending, 'cancel-me', undefined, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    returned,
    (error: unknown) => error instanceof RustraCommandError && error.code === 'cancelled',
  );
  resolveLate(42);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});

test('invokeWithTimeout without timeoutMs passes through directly', async () => {
  const ok: EngineClient = {
    invoke<T>(_command: string, _args?: unknown, _options?: unknown): Promise<T> {
      return Promise.resolve(42 as unknown as T);
    },
  };
  assert.equal(await invokeWithTimeout(ok, 'x', undefined, {}), 42);
  assert.equal(await invokeWithTimeout(ok, 'x', undefined, undefined), 42);
});

test('invokeWithTimeout without timeout preserves the engine Promise identity', async () => {
  const original = Promise.resolve(42);
  const ok: EngineClient = {
    invoke<T>(): Promise<T> {
      return original as Promise<T>;
    },
  };
  const returned = invokeWithTimeout(ok, 'x');
  assert.equal(returned, original, 'hot path must not add another Promise/microtask layer');
  assert.equal(await returned, 42);
});

test('invokeWithTimeout converts a synchronous engine throw into a rejected Promise', async () => {
  const broken: EngineClient = {
    invoke(): Promise<never> {
      throw new RustraCommandError('invoke.failed', 'sync failure');
    },
  };
  const returned = invokeWithTimeout(broken, 'x');
  assert.ok(returned instanceof Promise, 'public invoke contract must remain Promise-based');
  await assert.rejects(returned, (error: unknown) => {
    assert.ok(error instanceof RustraCommandError);
    assert.equal(error.code, 'invoke.failed');
    return true;
  });
});

test('global invoke applies timeoutMs from options', async () => {
  // 기존 글로벌 invoke 옵션 전달 테스트(T1)와 동일한 센티넬 패턴 — 이 테스트가
  // 실패로 끝나도 hanging 엔진이 글로벌에 남아 이후 테스트를 오염시키지 않게
  // finally 로 원복한다.
  const hanging: EngineClient = { invoke: () => new Promise(() => {}) };
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(hanging);
  try {
    await assert.rejects(
      invoke('slow', undefined, { timeoutMs: 30 }),
      (err: unknown) => (err as RustraCommandError).code === 'transport.timeout',
    );
  } finally {
    configure(sentinel);
  }
});

test('global invokeBatch applies batch timeout from min entry timeoutMs', async () => {
  // 항목 timeoutMs 의 최솟값(30ms)이 배치 전체의 타임아웃 레이스로 적용된다 —
  // hanging 배치 엔진도 transport.timeout 으로 탈출. 센티넬 패턴으로 글로벌 원복.
  const hanging = {
    invoke: () => new Promise(() => {}),
    invokeBatch: (_entries: BatchEntry[]) => new Promise<never>(() => {}),
  } as unknown as EngineClient;
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(hanging);
  try {
    await assert.rejects(
      invokeBatch([
        { command: 'a', options: { timeoutMs: 30 } },
        { command: 'b', options: { timeoutMs: 500 } },
      ]),
      (err: unknown) => {
        assert.ok(err instanceof RustraCommandError);
        assert.equal(err.code, 'transport.timeout');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  } finally {
    configure(sentinel);
  }
});

test('global invokeBatch without timeoutMs passes through unchanged', async () => {
  const ok = {
    invoke: () => new Promise(() => {}),
    invokeBatch: async (_entries: BatchEntry[]) => [1, 2],
  } as unknown as EngineClient;
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(ok);
  try {
    const out = await invokeBatch<number[]>([{ command: 'a' }, { command: 'b' }]);
    assert.deepEqual(out, [1, 2]);
  } finally {
    configure(sentinel);
  }
});

test('global invokeBatch rejects unsupported engines as a Promise', async () => {
  const engine: EngineClient = {
    invoke: async <T>() => undefined as T,
  };
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(engine);
  try {
    const returned = invokeBatch([{ command: 'unsupported' }]);
    assert.equal(typeof returned.then, 'function');
    await assert.rejects(returned, /does not support invokeBatch/);
  } finally {
    configure(sentinel);
  }
});

// ── T0-3: 치환 재동기화 — generation 게이트로 스테일 캐시 차단 ──

test('dynamic route resyncs live schema when native generation advances (T0-3)', async () => {
  // register → invoke(id 7 기록) → replace 후 generation 상승 → 재 invoke 는
  // 재동기화된 새 commandId 로 Tier 3 요청을 보내야 한다.
  let generation = 1;
  let dynamicCommandId = 7;
  const seenIds: number[] = [];
  let schemaFetches = 0;
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 7 }], undefined, 1),
    schemaGeneration: () => generation,
    invokeImpl: (payload) => {
      seenIds.push(new DataView(payload).getUint16(0, true));
      return tier3Success({ v: dynamicCommandId });
    },
  });
  // getSchema 가 호출될 때마다 현재 세대의 스키마를 만들어 준다 — 치환 시뮬레이션.
  (native as { getSchema: () => ArrayBuffer }).getSchema = () => {
    schemaFetches++;
    return schemaBytes([{ name: 'dyn', commandId: dynamicCommandId }], undefined, generation);
  };

  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke<{ v: number }>('dyn', {});
  assert.deepEqual(seenIds, [7]);

  // 치환 — commandId 가 8 로 바뀌고 세대가 상승.
  generation = 2;
  dynamicCommandId = 8;
  await engine.invoke<{ v: number }>('dyn', {});
  assert.deepEqual(seenIds, [7, 8], 'resync must pick up the new commandId');
  assert.ok(schemaFetches >= 2, 'live schema must be refetched after generation change');
});

test('dynamic route skips generation polling when native does not expose it (T0-3)', async () => {
  // 구 네이티브 — getSchemaGeneration 미노출 → 현상 유지(1회 조회 후 캐시).
  let schemaFetches = 0;
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 3 }]),
    invokeImpl: () => tier3Success({ v: 1 }),
  });
  (native as { getSchema: () => ArrayBuffer }).getSchema = () => {
    schemaFetches++;
    return schemaBytes([{ name: 'dyn', commandId: 3 }]);
  };
  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke('dyn', {});
  await engine.invoke('dyn', {});
  assert.equal(schemaFetches, 1, 'without generation exposure the cache must hold');
});

test('stale cached dynamic command is not found after resync shows removal (T0-3)', async () => {
  // 치환으로 명령이 사라진 경우 — 재동기화 후 not_found 로 시끄럽게 실패.
  let generation = 1;
  let present = true;
  const native = makeTypedNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 7 }], undefined, 1),
    schemaGeneration: () => generation,
    invokeImpl: () => tier3Success({ v: 1 }),
  });
  (native as { getSchema: () => ArrayBuffer }).getSchema = () =>
    schemaBytes(present ? [{ name: 'dyn', commandId: 7 }] : [], undefined, generation);

  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke('dyn', {});
  present = false;
  generation = 2;
  await assert.rejects(
    engine.invoke('dyn', {}),
    (error: unknown) => error instanceof RustraCommandError && error.code === 'command.not_found',
  );
});

test('async propagate path gates on generation resync before live schema lookup (T0-3)', async () => {
  // 동기 dispatch 와 달리 async 전파 경로(invokeAsync+invokeCancel)는 별도의
  // resync 호출이 없었다 — lookupCachedLiveSchemaEntry 가 게이트를 흡수한 뒤로는
  // replace 후 재호출이 스테일 commandId 코덱/프레임을 쓰지 않음을 고정한다.
  let generation = 1;
  let dynamicCommandId = 7;
  const seenIds: number[] = [];
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 7 }], undefined, 1),
    schemaGeneration: () => generation,
    invokeImpl: (payload) => {
      seenIds.push(new DataView(payload).getUint16(0, true));
      return tier3Success({ v: dynamicCommandId });
    },
  });
  (native as { getSchema: () => ArrayBuffer }).getSchema = () =>
    schemaBytes([{ name: 'dyn', commandId: dynamicCommandId }], undefined, generation);
  native.invokeAsync = (payload: ArrayBuffer, cb: (resp: ArrayBuffer) => void) => {
    seenIds.push(new DataView(payload).getUint16(0, true));
    cb(tier3Success({ v: dynamicCommandId }));
    return 1;
  };
  native.invokeCancel = () => true;
  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke<{ v: number }>('dyn', {});
  assert.deepEqual(seenIds, [7]);

  // 치환 — commandId 7→8, 세대 상승. async(signal) 경로로 재호출한다.
  generation = 2;
  dynamicCommandId = 8;
  const ac = new AbortController();
  await engine.invoke<{ v: number }>('dyn', {}, { signal: ac.signal });
  assert.deepEqual(seenIds, [7, 8], 'async path must resync before the live schema lookup');
});

test('dynamic codec cache prunes stale-generation codecs when the resync epoch advances', async () => {
  // 세대가 바뀌면(resync 에포크 상승) 이전 세대 entry 의 코덱은 회수 가능해야
  // 한다 — 강한 참조 맵이라 GC 에 맡기면 dev 치환 반복에서 구 코덱이 누적된다.
  const { createRkyvSchemaRuntime } = await import('./rkyv-engine-schema.js');
  const { createDynamicCodecRuntime } = await import('./rkyv-engine-dynamic-codec.js');
  let generation = 1;
  let commands: Array<Record<string, unknown>> = [];
  const native: RkyvV2SchemaNative = {
    getSchema: () => {
      const doc = { packageId: 't', schemaGeneration: generation, commands };
      return bytesFromStrings([JSON.stringify(doc)]);
    },
    getSchemaGeneration: () => generation,
    invokeRkyvV2: () => new ArrayBuffer(0),
  };
  const schema = createRkyvSchemaRuntime(native);
  const codecs = createDynamicCodecRuntime(schema);

  const postcardSchema = {
    type: 'object',
    required: ['v'],
    properties: { v: { type: 'integer', format: 'int64' } },
  };
  const entryOf = (
    commandId: number,
  ): { name: string; commandId: number } & Record<string, unknown> => ({
    name: `dyn${commandId}`,
    commandId,
    inputSchema: postcardSchema,
    outputSchema: postcardSchema,
  });

  // 세대 1 — 동적 명령 2개 조회로 코덱 2개 캐시.
  commands = [entryOf(4), entryOf(5)];
  const e4 = schema.lookupCachedLiveSchemaEntry('dyn4')!;
  const e5 = schema.lookupCachedLiveSchemaEntry('dyn5')!;
  assert.ok(codecs.lookupBinaryCodec(e4));
  assert.ok(codecs.lookupBinaryCodec(e5));
  assert.equal(codecs.size, 2, 'two codecs cached for generation 1');

  // 세대 2 — 치환으로 세대 상승, 게이트가 재조회하면 새 entry 객체.
  generation = 2;
  commands = [entryOf(4)];
  const e4New = schema.lookupCachedLiveSchemaEntry('dyn4')!;
  assert.notEqual(e4New, e4, 'generation resync must produce fresh entry objects');
  assert.ok(codecs.lookupBinaryCodec(e4New));
  assert.equal(codecs.size, 1, 'generation change must prune the old-generation codecs');
});

// ── (T2-2) 스키마→postcard 코덱 인터프리터 ──────────────────
// live_schema 의 JSON Schema 로 생성한 인터프리터 코덱이 generated 코드젠 코덱과
// **바이트 동일**임을 PINNED hex(examples/calculator/tests/wire_fixtures.rs 와
// examples/calculator/ts/cross-wire.test.ts 가 공유하는 canonical wire)로
// 고정한다. 동일 타입에 대해 스키마 → 인터프리터 경로와 코드젠 경로가 같은
// 와이어를 내지 않으면 동적 명령 fast-path 가 정적 명령과 어긋난다.

import { createSchemaPostcardCodec } from './schema-postcard-codec.js';

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex: string): ArrayBuffer {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u.buffer;
}
function schemaCodec(
  commandId: number,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
) {
  const codec = createSchemaPostcardCodec(commandId, inputSchema as never, outputSchema as never);
  assert.ok(codec, 'supported schema must compile');
  return codec;
}

test('schema codec: i64 pair (addNumbers) — PINNED request/response wire', () => {
  const codec = schemaCodec(
    1,
    {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'integer', format: 'int64' },
        b: { type: 'integer', format: 'int64' },
      },
    },
    {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'integer', format: 'int64' } },
    },
  );
  assert.equal(bytesToHex(codec.encode({ a: 2, b: 3 })), '01000406', 'TS→Rust request hex');
  const r = codec.decode(hexToBytes('01000000000000000a'));
  assert.equal(r.ok, true);
  assert.equal(r.result && (r.result as { value: number }).value, 5);
});

test('schema codec: String (greet) — PINNED request/response wire', () => {
  const codec = schemaCodec(
    5,
    {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
    {
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string' } },
    },
  );
  assert.equal(bytesToHex(codec.encode({ name: 'Lynx' })), '0500044c796e78');
  const r = codec.decode(hexToBytes('01000000000000000c48656c6c6f2c204c796e7821'));
  assert.equal(r.ok, true);
  assert.equal(r.result && (r.result as { message: string }).message, 'Hello, Lynx!');
});

test('schema codec: error frame (divide by zero) — PINNED wire → RustraError', () => {
  const codec = schemaCodec(
    10,
    {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    },
    { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
  );
  assert.equal(bytesToHex(codec.encode({ a: 1, b: 0 })), '0a000200');
  const r = codec.decode(
    hexToBytes(
      '00000000000000002a00136d6174682e6469766964655f62795f7a65726f1563616e6e6f7420646976696465206279207a65726f',
    ),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'math.divide_by_zero');
  assert.equal(r.error?.message, 'cannot divide by zero');
});

test('schema codec: map count+(k,v)* (scoreTotal) — structure + response', () => {
  const codec = schemaCodec(
    15,
    {
      type: 'object',
      required: ['scores'],
      properties: {
        scores: { type: 'object', additionalProperties: { type: 'integer', format: 'int64' } },
      },
    },
    {
      type: 'object',
      required: ['count', 'total'],
      properties: {
        count: { type: 'integer', format: 'uint32' },
        total: { type: 'integer', format: 'int64' },
      },
    },
  );
  // Rust 측 HashMap 순회가 비결정적이라 hex 고정 불가(코드젠 계약 동일) —
  // 엔트리 수/길이 구조 검증.
  const req = new Uint8Array(codec.encode({ scores: { a: 10, b: 32 } }));
  assert.equal(req[0], 0x0f);
  assert.equal(req[2], 2, 'entry count');
  assert.equal(req.length, 9, 'count(1) + 2*(1 key + zigzag val)');
  const r = codec.decode(hexToBytes('01000000000000000254'));
  assert.equal(r.ok, true);
  const out = r.result as { count: number; total: number };
  assert.equal(out.total, 42);
  assert.equal(out.count, 2);
});

test('schema codec: postcard tuple prefix-free (span) — PINNED wire', () => {
  const codec = schemaCodec(
    16,
    {
      type: 'object',
      required: ['pair'],
      properties: {
        pair: {
          type: 'array',
          items: [{ type: 'string' }, { type: 'integer', format: 'int64' }],
          maxItems: 2,
          minItems: 2,
        },
      },
    },
    {
      type: 'object',
      required: ['first', 'second'],
      properties: { first: { type: 'string' }, second: { type: 'integer', format: 'int64' } },
    },
  );
  assert.equal(bytesToHex(codec.encode({ pair: ['hi', -5] })), '100002686909');
  const r = codec.decode(hexToBytes('010000000000000002686909'));
  assert.equal(r.ok, true);
  const out = r.result as { first: string; second: number };
  assert.equal(out.first, 'hi');
  assert.equal(out.second, -5);
});

test('schema codec: u64/u32 plain varint (gauge) — PINNED wire', () => {
  const codec = schemaCodec(
    17,
    {
      type: 'object',
      required: ['limit', 'offset'],
      properties: {
        limit: { type: 'integer', format: 'uint64' },
        offset: { type: 'integer', format: 'uint32' },
      },
    },
    {
      type: 'object',
      required: ['next'],
      properties: { next: { type: 'integer', format: 'uint64' } },
    },
  );
  assert.equal(bytesToHex(codec.encode({ limit: 300, offset: 70000 })), '1100ac02f0a204');
  const r = codec.decode(hexToBytes('01000000000000009ca504'));
  assert.equal(r.ok, true);
  assert.equal(r.result && (r.result as { next: number }).next, 70300);
});

test('schema codec: bytes len+raw (sizeOf) — PINNED wire', () => {
  const codec = schemaCodec(
    14,
    {
      type: 'object',
      required: ['data'],
      properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
    },
    {
      type: 'object',
      required: ['checksum', 'len'],
      properties: {
        checksum: { type: 'integer', format: 'uint32' },
        len: { type: 'integer', format: 'uint32' },
      },
    },
  );
  assert.equal(bytesToHex(codec.encode({ data: [1, 2, 3, 250] })), '0e0004010203fa');
  const r = codec.decode(hexToBytes('0100000000000000800204'));
  assert.equal(r.ok, true);
  const out = r.result as { checksum: number; len: number };
  assert.equal(out.checksum, 256);
  assert.equal(out.len, 4);
});

test('schema codec: Vec<u64> + Option<i64> (wideAgg) — 64-bit boundaries', () => {
  const codec = schemaCodec(
    28,
    {
      type: 'object',
      required: ['samples'],
      properties: {
        samples: { type: 'array', items: { type: 'integer', format: 'uint64' } },
        offset: { type: ['integer', 'null'], format: 'int64' },
      },
    },
    {
      type: 'object',
      required: ['max', 'adjusted'],
      properties: {
        max: { type: 'integer', format: 'uint64' },
        adjusted: { type: 'integer', format: 'int64' },
      },
    },
  );
  assert.equal(
    bytesToHex(
      codec.encode({
        samples: [1, 127, 128, 9007199254740993n, 18446744073709551615n],
        offset: -9223372036854775808n,
      }),
    ),
    '1c0005017f80018180808080808010ffffffffffffffffff0101ffffffffffffffffff01',
  );
  const r = codec.decode(hexToBytes('0100000000000000ffffffffffffffffff01f5ffffffffffffffff01'));
  assert.equal(r.ok, true);
  const out = r.result as { max: number | bigint; adjusted: number | bigint };
  assert.equal(out.max, 18446744073709551615n, 'u64::MAX restored as bigint');
  assert.equal(out.adjusted, -9223372036854775803n, 'i64::MIN + 5 restored');
});

test('schema codec: uniqueItems Set (tagSet) — insertion order, Set restore', () => {
  const codec = schemaCodec(
    29,
    {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'integer', format: 'int64' }, uniqueItems: true },
      },
    },
    {
      type: 'object',
      required: ['tags'],
      properties: { tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
    },
  );
  assert.equal(
    bytesToHex(codec.encode({ ids: new Set<bigint | number>([-7, 15, 1000]) })),
    '1d00030d1ed00f',
  );
  const r = codec.decode(hexToBytes('01000000000000000303742d3705743130303003743135'));
  assert.equal(r.ok, true);
  const tags = (r.result as { tags: Set<string> }).tags;
  assert.ok(tags instanceof Set);
  assert.deepEqual([...tags], ['t-7', 't1000', 't15']);
});

test('schema codec: unsupported nodes return null (oneOf, 3-term anyOf, mixed object)', () => {
  // payload enum(oneOf) — Rust 는 complex 라우트로 승격하므로 JS 인터프리터도
  // 만들지 않는다(엔진이 Tier 3 가 아니라 complex 로 우회하지만, 이 모듈의
  // 계약은 null 반환).
  assert.equal(
    createSchemaPostcardCodec(
      1,
      {
        type: 'object',
        required: ['status'],
        properties: { status: { oneOf: [{ type: 'string', enum: ['Idle'] }, { type: 'object' }] } },
      } as never,
      { type: 'object', properties: {} },
    ),
    null,
  );
  assert.equal(
    createSchemaPostcardCodec(
      1,
      {
        type: 'object',
        required: ['v'],
        properties: {
          v: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'boolean' }] },
        },
      } as never,
      { type: 'object', properties: {} },
    ),
    null,
  );
  // 혼합 object (properties + additionalProperties) — 미지원.
  assert.equal(
    createSchemaPostcardCodec(
      1,
      {
        type: 'object',
        properties: { a: { type: 'integer' } },
        additionalProperties: { type: 'string' },
      } as never,
      { type: 'object', properties: {} },
    ),
    null,
  );
});

test('schema codec: $ref resolution through definitions', () => {
  // 정의가 없으면 fail-closed(null) — Tier 3 로 안전하게 폴백.
  const missing = createSchemaPostcardCodec(
    2,
    {
      type: 'object',
      required: ['item'],
      properties: { item: { $ref: '#/definitions/Item' } },
    } as never,
    {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', format: 'uint32' } },
    } as never,
    { type: 'object', properties: {} } as never,
  );
  assert.equal(missing, null, 'missing definition fails closed');
  // definitions 해석 성공 — struct 선언순(postcard 필드순) 인코딩.
  const withDefs = createSchemaPostcardCodec(
    2,
    {
      type: 'object',
      required: ['item'],
      properties: { item: { $ref: '#/definitions/Item' } },
    } as never,
    {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', format: 'uint32' } },
    } as never,
    {
      Item: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    } as never,
  );
  assert.ok(withDefs, '$ref to a known definition compiles');
  assert.equal(bytesToHex(withDefs!.encode({ item: { id: 3 } })), '020006');
});

// ── (T2-3) 동적 명령 postcard/complex 라우팅 ────────────────
// Rust registry 의 3-way 판정(runtime_registry_tests 동적 계약)을 JS 엔진이
// 미러한다: postcard 지원 스키마는 인터프리터 binary, oneOf 는 complex binary
// (Rust 가 t3align 계약으로 complex 로 승격), 둘 다 거부(anyOf 3항)만 Tier 3.

test('engine routes postcard-supported dynamic commands through the schema interpreter (T2-3)', async () => {
  // Rust 계약: register("echo", echo) — EchoIn{v:i64} 는 postcard 지원 →
  // rkyv_v2_tier3=false, 핸들러는 [ok][pad][postcard(EchoOut)] 로 응답한다.
  const holder: { req: ArrayBuffer | null } = { req: null };
  const native = makeNative({
    schema: schemaBytes(
      [
        {
          name: 'echo',
          commandId: 7,
          inputSchema: {
            type: 'object',
            required: ['v'],
            properties: { v: { type: 'integer', format: 'int64' } },
          },
          outputSchema: {
            type: 'object',
            required: ['v'],
            properties: { v: { type: 'integer', format: 'int64' } },
          },
        },
      ],
      undefined,
      3,
    ),
    invokeImpl: (payload) => {
      holder.req = payload;
      // Rust postcard 핸들러 응답: [ok=1][pad 3][postcard(v=zigzag(7)=14)]
      const ab = new ArrayBuffer(10);
      const u = new Uint8Array(ab);
      u[0] = 1;
      u[8] = 14;
      return ab;
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invoke<{ v: number }>('echo', { v: 7 });
  assert.equal(out.v, 7);
  // 요청이 postcard binary(Tier 3 JSON 아님)임을 고정 — [id u16][zigzag(7)].
  const req = holder.req as ArrayBuffer;
  assert.ok(req);
  const u = new Uint8Array(req);
  assert.equal(u.length, 3, 'postcard request is id(2)+zigzag(7)=1B varint, not JSON');
  assert.equal(new DataView(req).getUint16(0, true), 7);
  assert.deepEqual(Array.from(u.slice(2)), [14], 'zigzag(7)=14 — postcard, not JSON text');
});

test('engine routes dynamic oneOf commands through a compiled complex codec (T2-3)', async () => {
  // Rust 계약: oneOf payload enum 동적 등록 → complex binary 라우트
  // (dynamic_oneof_schema_gets_complex_binary_handler). JS 엔진도 Tier 3 로
  // 보내면 와이어가 어긋나므로 createComplexCodec 으로 응답해야 한다.
  // 스키마는 schemars 실제 형태(probe): oneOf 는 definitions.ShapeLabel 안에
  // 있고(Idle=enum, Active=단일 프로퍼티 래퍼), live schema 는
  // x-rustra-variant-order 를 annotate 한다(키 정렬 — Active=0, Idle=1).
  const holder: { req: ArrayBuffer | null } = { req: null };
  const native = makeNative({
    schema: schemaBytes([
      {
        name: 'shape',
        commandId: 5,
        inputSchema: {
          type: 'object',
          required: ['status'],
          properties: { status: { $ref: '#/definitions/ShapeLabel' } },
        },
        outputSchema: {
          type: 'object',
          required: ['label'],
          properties: { label: { type: 'string' } },
        },
        definitions: {
          ShapeLabel: {
            oneOf: [
              { type: 'string', enum: ['Idle'] },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  Active: {
                    type: 'object',
                    required: ['level'],
                    properties: { level: { type: 'integer', format: 'int64' } },
                  },
                },
                required: ['Active'],
              },
            ],
            'x-rustra-variant-order': ['Idle', 'Active'],
          },
        },
      } as never,
    ]),
    invokeImpl: (payload) => {
      holder.req = payload;
      // Rust complex 핸들러 응답: [ok=1][pad 7][complex body] — body 는
      // struct{label: string} declaration순 → uvar(len)+"active:9".
      const label = new TextEncoder().encode('active:9');
      const bodyLen = 1 + label.length; // uvar len(1바이트) + bytes
      const ab = new ArrayBuffer(8 + bodyLen);
      const u = new Uint8Array(ab);
      u[0] = 1;
      u[8] = label.length;
      u.set(label, 9);
      return ab;
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invoke<{ label: string }>('shape', {
    status: { Active: { level: 9 } },
  });
  assert.equal(out.label, 'active:9');
  // 요청이 complex binary([id u16][variant 0][unwrapSingle→zigzag level]) 임을
  // 고정 — variant 0 = Active (키 정렬), level=zigzag(9)=18.
  const req = holder.req as ArrayBuffer;
  const u = new Uint8Array(req);
  assert.equal(new DataView(req).getUint16(0, true), 5);
  assert.deepEqual(
    Array.from(u.slice(2)),
    [0, 18],
    'complex wire: variant index 0 (Active, key-sorted) + zigzag(9), not JSON',
  );
});

test('engine keeps unsupported dynamic schemas on Tier 3 (T2-3)', async () => {
  // Rust 계약: 3-변형 untagged enum(anyOf 3항)은 postcard/complex 둘 다 거부 →
  // rkyv_v2_tier3=true. JS 인터프리터도 null 이므로 기존 JSON 경로가 유지된다.
  const holder: { req: ArrayBuffer | null } = { req: null };
  const native = makeNative({
    schema: schemaBytes([
      {
        name: 'anyShape',
        commandId: 9,
        inputSchema: {
          type: 'object',
          required: ['v'],
          properties: {
            v: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'boolean' }] },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['label'],
          properties: { label: { type: 'string' } },
        },
      } as never,
    ]),
    invokeImpl: (payload) => {
      holder.req = payload;
      return tier3Success({ label: 'text:hi' });
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invoke<{ label: string }>('anyShape', { v: 'hi' });
  assert.equal(out.label, 'text:hi');
  // 요청이 Tier 3 JSON([id u16][json]) 임을 고정.
  const req = holder.req as ArrayBuffer;
  const u = new Uint8Array(req);
  assert.equal(new DataView(req).getUint16(0, true), 9);
  assert.equal(new TextDecoder().decode(u.slice(2)), JSON.stringify({ v: 'hi' }));
});

test('schema interpreter recompiles after generation resync picks up a new codec (T2-3)', async () => {
  // 세대 게이트(T0-3)가 live schema 를 재조회하면 스키마도 새로 읽히고, 인터프리터
  // 캐시(compute-if-absent)는 entry 객체 식별로 무효화된다 — replace 로 postcard
  // 지원 형태가 된 명령이 JSON 이 아니라 postcard 로 가는지 고정.
  let generation = 1;
  let docCommands: Array<Record<string, unknown>> = [
    {
      name: 'dyn',
      commandId: 4,
      inputSchema: {
        type: 'object',
        required: ['v'],
        properties: {
          v: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'boolean' }] },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['v'],
        properties: { v: { type: 'integer' } },
      },
    },
  ];
  const frames: ArrayBuffer[] = [];
  const native = makeNative({
    schemaGeneration: () => generation,
    invokeImpl: (payload) => {
      frames.push(payload);
      const u = new Uint8Array(payload);
      if (u.length > 2 && u[2] === 0x7b /* '{' */) return tier3Success({ v: 1 });
      // postcard 프레임 — Rust postcard 핸들러 응답 [ok][pad][zigzag(1)=2].
      const ab = new ArrayBuffer(9);
      const resp = new Uint8Array(ab);
      resp[0] = 1;
      resp[8] = 2;
      return ab;
    },
  });
  (native as { getSchema: () => ArrayBuffer }).getSchema = () => {
    const doc = { packageId: 't', schemaGeneration: generation, commands: docCommands };
    return bytesFromStrings([JSON.stringify(doc)]);
  };
  const engine = createRkyvV2Engine(native, new Map());
  await engine.invoke('dyn', { v: 'text' });
  assert.equal(
    new TextDecoder().decode(new Uint8Array(frames[0]!).slice(2)),
    JSON.stringify({ v: 'text' }),
    'first invoke: unsupported schema stays JSON',
  );
  // replace — 동일 이름/id, 이제 postcard 지원 형태(i64).
  generation = 2;
  docCommands = [
    {
      name: 'dyn',
      commandId: 4,
      inputSchema: {
        type: 'object',
        required: ['v'],
        properties: { v: { type: 'integer', format: 'int64' } },
      },
      outputSchema: { type: 'object', required: ['v'], properties: { v: { type: 'integer' } } },
    },
  ];
  const out = await engine.invoke<{ v: number }>('dyn', { v: 7 });
  assert.equal(out.v, 1);
  assert.equal(frames.length, 2);
  const second = new Uint8Array(frames[1]!);
  assert.deepEqual(
    Array.from(second.slice(2)),
    [14],
    'post-resync invoke must speak postcard (zigzag), not JSON',
  );
});

// ── withRetry (readiness Task 6) ────────────────────────────

/** 재시도 판정 테스트용 retryable 에러 — TimeoutError 서브클래스 (retryable=true). */
function timeoutError(): TimeoutError {
  return new TimeoutError('timed out');
}

test('withRetry succeeds on the second attempt after one retryable failure', async () => {
  const attempts: number[] = [];
  const out = await withRetry(
    (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) return Promise.reject(timeoutError());
      return Promise.resolve('ok');
    },
    { retries: 2, baseDelayMs: 1 },
  );
  assert.equal(out, 'ok');
  assert.deepEqual(attempts, [0, 1]);
});

test('withRetry rethrows the last error unchanged after retries are exhausted', async () => {
  const attempts: number[] = [];
  const lastError = timeoutError();
  let call = 0;
  let caught: unknown;
  try {
    await withRetry(
      (attempt) => {
        attempts.push(attempt);
        call++;
        return Promise.reject(call < 3 ? timeoutError() : lastError);
      },
      { retries: 2, baseDelayMs: 1 },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, lastError, 'exhaustion must reject with the identical last error object');
  assert.deepEqual(attempts, [0, 1, 2]);
});

test('withRetry rejects immediately without retrying non-retryable codes', async () => {
  let calls = 0;
  const notFound = new RustraCommandError(RustraErrorCode.CommandNotFound, 'missing', false);
  let caught: unknown;
  try {
    await withRetry(
      () => {
        calls++;
        return Promise.reject(notFound);
      },
      { retries: 2, baseDelayMs: 1 },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, notFound, 'non-retryable error must come out unchanged');
  assert.equal(calls, 1, 'non-retryable failure must not schedule a retry');
});

test('withRetry respects a custom retryIf in both directions', async () => {
  // 방향 1: 기본 판정은 retryable 코드인데 retryIf 가 false → 즉시 거부.
  let callsA = 0;
  const retryable = timeoutError();
  let caughtA: unknown;
  try {
    await withRetry(
      () => {
        callsA++;
        return Promise.reject(retryable);
      },
      { retries: 2, baseDelayMs: 1, retryIf: () => false },
    );
  } catch (error) {
    caughtA = error;
  }
  assert.equal(caughtA, retryable);
  assert.equal(callsA, 1, 'retryIf=false must suppress the default predicate');

  // 방향 2: 기본 판정은 non-retryable 코드인데 retryIf 가 true → 재시도됨.
  let callsB = 0;
  const notFound = new RustraCommandError(RustraErrorCode.CommandNotFound, 'missing', false);
  const out = await withRetry(
    () => {
      callsB++;
      return callsB === 1 ? Promise.reject(notFound) : Promise.resolve('recovered');
    },
    { retries: 1, baseDelayMs: 1, retryIf: () => true },
  );
  assert.equal(out, 'recovered');
  assert.equal(callsB, 2, 'retryIf=true must override the default predicate entirely');
});

test('withRetry rejects with the retryIf predicate error when the predicate itself throws', async () => {
  let calls = 0;
  const predicateBoom = new Error('predicate exploded');
  let caught: unknown;
  try {
    await withRetry(
      () => {
        calls++;
        return Promise.reject(timeoutError());
      },
      {
        retries: 3,
        baseDelayMs: 1,
        retryIf: () => {
          throw predicateBoom;
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, predicateBoom, 'predicate throw must propagate unchanged');
  assert.equal(calls, 1, 'predicate failure must not schedule a retry');
});

test('withRetry promotes a mid-flight signal abort to CancelledError', async () => {
  const controller = new AbortController();
  const attempts: number[] = [];
  const pending = withRetry(
    (attempt) => {
      attempts.push(attempt);
      if (attempt === 0) controller.abort(); // 첫 실패 직후 abort — pre-aborted fast path.
      return Promise.reject(timeoutError());
    },
    { retries: 3, baseDelayMs: 50, signal: controller.signal },
  );
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof CancelledError && err.code === RustraErrorCode.Cancelled,
  );
  assert.deepEqual(attempts, [0], 'abort during backoff sleep must cancel before the next attempt');
});

test('withRetry aborts a pending backoff sleep via the registered listener and preserves cause', async () => {
  // sleep Promise 생성자 블록(타이머 생성 + abort 리스너 등록 + abort 시
  // clearTimeout)을 실제로 타는 경로 — fn 안 동기 abort 는 항상 pre-aborted
  // fast path 로 새므로, 타이머 abort 를 쓴다(경쟁 없음: 5ms ≪ 10s 백오프).
  const controller = new AbortController();
  const cause = timeoutError();
  const attempts: number[] = [];
  const startedAt = Date.now();
  const pending = withRetry(
    (attempt) => {
      attempts.push(attempt);
      if (attempt === 0) {
        setTimeout(() => controller.abort(), 5);
        return Promise.reject(cause);
      }
      return Promise.resolve('unreachable');
    },
    { retries: 3, baseDelayMs: 10_000, signal: controller.signal },
  );
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(caught instanceof CancelledError, 'timer abort must promote to CancelledError');
  assert.equal((caught as CancelledError).code, RustraErrorCode.Cancelled);
  assert.equal(
    (caught as CancelledError).cause,
    cause,
    'abort promotion must preserve the failed error as cause',
  );
  assert.equal(attempts.length, 1, 'aborted sleep must cancel before the next attempt');
  assert.ok(elapsed < 5000, `abort must cut the 10s sleep short immediately, took ${elapsed}ms`);
});

test('withRetry rejects with CancelledError immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls++;
        return Promise.resolve('never');
      },
      { signal: controller.signal },
    ),
    (err: unknown) => err instanceof CancelledError && err.code === RustraErrorCode.Cancelled,
  );
  assert.equal(calls, 0, 'pre-aborted signal must never invoke fn');
});

test('withRetry with retries 0 makes exactly one attempt and never sleeps', async () => {
  const attempts: number[] = [];
  let caught: unknown;
  try {
    await withRetry(
      (attempt) => {
        attempts.push(attempt);
        return Promise.reject(timeoutError());
      },
      { retries: 0, baseDelayMs: 10_000 },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TimeoutError, 'single attempt must reject with the original error');
  assert.deepEqual(attempts, [0], 'retries=0 must not retry even on retryable failures');
});

test('withRetry rejects invalid retries values with TypeError instead of looping forever', async () => {
  // attempt >= NaN 은 항상 거짓 — 가드 없으면 조용한 무한 루프. async 함수라
  // TypeError 는 동기 throw 가 아니라 즉시 rejection 로 관찰된다.
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      withRetry(() => Promise.resolve('x'), { retries: bad }),
      (err: unknown) => err instanceof TypeError,
      `retries=${String(bad)} must reject with TypeError before any attempt`,
    );
  }
  // 음이 아닌 유한 소수는 유효 — attempt 인덱스와의 수치 비교(>=)라 0.5 는
  // attempt 1 에서 경계를 넘어 총 2회 시도된다 (floor/round 아님).
  const attempts: number[] = [];
  let fractional: unknown;
  try {
    await withRetry(
      (attempt) => {
        attempts.push(attempt);
        return Promise.reject(timeoutError());
      },
      { retries: 0.5, baseDelayMs: 1 },
    );
  } catch (error) {
    fractional = error;
  }
  assert.ok(fractional instanceof TimeoutError, 'retries=0.5 must exhaust and rethrow');
  assert.deepEqual(attempts, [0, 1], 'retries=0.5 exhausts at attempt 1 (numeric boundary)');
});

test('withRetry preserves arbitrary rejection values unchanged', async () => {
  const bigintPayload = 9007199254740993n; // Number.MAX_SAFE_INTEGER 초과 bigint
  let caught: unknown;
  try {
    await withRetry(() => Promise.reject(bigintPayload), { retries: 2, baseDelayMs: 1 });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, bigintPayload, 'non-Error rejection must come out by identity');
  assert.equal(typeof caught, 'bigint');
});

test('withRetry passes 0-based attempt numbers to fn', async () => {
  const attempts: number[] = [];
  await withRetry(
    (attempt) => {
      attempts.push(attempt);
      return attempts.length < 3 ? Promise.reject(timeoutError()) : Promise.resolve('done');
    },
    { retries: 3, baseDelayMs: 1 },
  );
  assert.deepEqual(attempts, [0, 1, 2]);
});

// ── 응답 셰이프 검증 경고 (readiness Task 8) — RUSTRA_DEBUG 버전 스큐 조기 감지 ──

type ShapeDebugEvent = { kind?: string; reason?: string; command?: string; value?: unknown };

/**
 * debug 모드 테스트 하네스 — `__RUSTRA_DEBUG__` 스위치를 켜고 console.debug
 * 미러 출력을 흡수해 테스트 결과를 깨끗하게 유지한다(node-loop.test.ts 관례).
 * `resetDebugEnvForTests()` 로 모듈 메모이즈된 dump 게이트 캐시를 먼저 무효화해
 * 주변 환경의 `RUSTRA_DEBUG=1` 이 스위치 판정에 새지 않게 한다(양방향 — 테스트
 * 시작 시 환경을 고정하고, cleanup 때도 무효화해 이후 테스트가 오염되지 않게
 * 한다). 반환된 cleanup 을 finally 에서 반드시 호출한다.
 */
function enableShapeDebugHarness(): () => void {
  resetDebugEnvForTests();
  (globalThis as { __RUSTRA_DEBUG__?: unknown }).__RUSTRA_DEBUG__ = true;
  const originalDebug = console.debug;
  console.debug = () => {};
  return () => {
    console.debug = originalDebug;
    delete (globalThis as { __RUSTRA_DEBUG__?: unknown }).__RUSTRA_DEBUG__;
    resetDebugEnvForTests();
  };
}

/** json-engine 테스트용 고정 payload 를 resolve 하는 가짜 transport. */
function envelopeTransport(payload: unknown): { invoke: (command: string) => Promise<unknown> } {
  return { invoke: () => Promise.resolve(payload) };
}

test('double envelope resolution emits response.shape and resolves unchanged in debug mode', async () => {
  const seen: ShapeDebugEvent[] = [];
  const sink = (event: unknown) => seen.push(event as ShapeDebugEvent);
  const payload = { ok: true, result: { value: 42 } };
  const engine = createJsonEngine(envelopeTransport(payload));
  const cleanup = enableShapeDebugHarness();
  try {
    configureDebug(sink);
    const result = await engine.invoke('echo', {});
    assert.deepEqual(result, { ok: true, result: { value: 42 } }, 'no transform of the result');
    const shapes = seen.filter((e) => e.kind === 'response.shape');
    assert.equal(shapes.length, 1, 'exactly one shape event per invoke');
    assert.equal(shapes[0]!.reason, 'double_envelope');
    assert.equal(shapes[0]!.command, 'echo');
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

test('resolved ok:false without error emits response.shape and still resolves in debug mode', async () => {
  const seen: ShapeDebugEvent[] = [];
  const engine = createJsonEngine(envelopeTransport({ ok: false }));
  const cleanup = enableShapeDebugHarness();
  try {
    configureDebug((event) => seen.push(event as ShapeDebugEvent));
    const result = await engine.invoke<{ ok: boolean }>('broken', {});
    assert.deepEqual(result, { ok: false }, 'warning only — the invoke still resolves');
    const event = seen.filter((e) => e.kind === 'response.shape')[0]!;
    assert.equal(event.reason, 'failed_without_error');
    assert.equal(event.command, 'broken');
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

test('resolved error envelope ({ok:false,error}) emits response.shape but keeps the value', async () => {
  // reject 경로의 정규화는 rejection 일 때만 동작한다 — transport 가 실패 엔벨로프를
  // 그대로 resolve 하면(스크 신호) 경고는 하되 기존 값 계약을 변형하지 않는다.
  const seen: ShapeDebugEvent[] = [];
  const error = { code: 'math.divide_by_zero', message: 'division by zero' };
  const engine = createJsonEngine(envelopeTransport({ ok: false, error }));
  const cleanup = enableShapeDebugHarness();
  try {
    configureDebug((event) => seen.push(event as ShapeDebugEvent));
    const result = await engine.invoke<{ ok: boolean; error: unknown }>('divide', {});
    assert.deepEqual(result, { ok: false, error });
    const event = seen.filter((e) => e.kind === 'response.shape')[0]!;
    assert.equal(event.reason, 'resolved_error_envelope');
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

test('broken envelope ({ok:true} payload-less) emits envelope_missing_payload', async () => {
  const seen: ShapeDebugEvent[] = [];
  const engine = createJsonEngine(envelopeTransport({ ok: true }));
  const cleanup = enableShapeDebugHarness();
  try {
    configureDebug((event) => seen.push(event as ShapeDebugEvent));
    await engine.invoke('noPayload', {});
    const event = seen.filter((e) => e.kind === 'response.shape')[0]!;
    assert.equal(event.reason, 'envelope_missing_payload');
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

test('debug disabled: no response.shape events (passthrough unchanged)', async () => {
  // 모듈 메모이즈된 dump 게이트 캐시를 먼저 무효화해야 주변 RUSTRA_DEBUG=1 환경이
  // 이 테스트로 새지 않는다(스위치 판정은 캐시 무효화 후 env 만 본다).
  resetDebugEnvForTests();
  const shapes: ShapeDebugEvent[] = [];
  const engine = createJsonEngine(envelopeTransport({ ok: true, result: { value: 1 } }));
  try {
    // sink-only 설치는 debugRustra 의 기존 계약(싱크만으로도 요청/응답 이벤트 도달)
    // 이지만, 셰이프 감지는 isRustraDebugEnabled 로만 게이트된다 — 감지 게이트는
    // 싱크 유무와 무관하게 debug 스위치만 본다. 여기선 스위치 없이 싱크만 설치.
    configureDebug((event) => {
      if ((event as ShapeDebugEvent).kind === 'response.shape')
        shapes.push(event as ShapeDebugEvent);
    });
    const result = await engine.invoke('echo', {});
    assert.deepEqual(result, { ok: true, result: { value: 1 } }, 'passthrough unchanged');
    assert.equal(shapes.length, 0, 'debug off must suppress the shape warning entirely');
  } finally {
    configureDebug(undefined);
    delete (globalThis as { __RUSTRA_DEBUG__?: unknown }).__RUSTRA_DEBUG__;
    resetDebugEnvForTests();
  }
});

test('plain payload without ok and primitive responses emit no shape event', async () => {
  for (const payload of [{ value: 42 }, { okay: true }, 'plain', 7, null, undefined]) {
    const seen: ShapeDebugEvent[] = [];
    const engine = createJsonEngine(envelopeTransport(payload));
    const cleanup = enableShapeDebugHarness();
    try {
      configureDebug((event) => seen.push(event as ShapeDebugEvent));
      const result = await engine.invoke('normal', {});
      assert.equal(result, payload, 'passthrough by identity');
      assert.equal(
        seen.filter((e) => e.kind === 'response.shape').length,
        0,
        `payload ${JSON.stringify(payload)} must not warn (false-positive guard)`,
      );
    } finally {
      configureDebug(undefined);
      cleanup();
    }
  }
});

test('detection never throws on exotic result objects (frozen, null-prototype)', async () => {
  const exotic: unknown[] = [
    Object.freeze({ ok: true, result: { frozen: true } }),
    Object.create(null) as unknown, // 프로토타입 없음 — hasOwnProperty.call 로 안전
    Object.freeze(Object.create(null, { ok: { value: false, enumerable: true } })),
  ];
  const cleanup = enableShapeDebugHarness();
  try {
    configureDebug(() => {});
    for (const payload of exotic) {
      const engine = createJsonEngine(envelopeTransport(payload));
      // 어떤 특이 객체도 invoke 자체를 실패로 만들지 않는다(경고는 절대 throw 금지).
      const result = await engine.invoke('weird', {});
      assert.equal(result, payload, 'exotic object passes through by identity');
    }
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

// ── rejection 경로 회귀 가드 — createJsonEngine 의 normalizeRustraError 배선 ──
// 셰이프 감지는 resolve 경로 전용이다. rejection 이 왔을 때 감지가 조용하다는
// 핀과, transport reject 값이 기존 정규화 계약으로 변환된다는 점을 함께 잠근다.

test('json-engine rejection path normalizes errors and emits no shape event', async () => {
  const shapes: ShapeDebugEvent[] = [];
  const cleanup = enableShapeDebugHarness();
  const rejectTransport = (reason: unknown) => ({
    invoke: () => Promise.reject(reason),
  });
  try {
    configureDebug((event) => {
      if ((event as ShapeDebugEvent).kind === 'response.shape')
        shapes.push(event as ShapeDebugEvent);
    });

    // 실패 엔벨로프 reject — 최상위 code/message 가 아니므로 normalizeRustraError 는
    // 구조화 경로에 진입하지 않고 unknown 으로 정규화한다(기존 계약 — 코드가
    // error 키 안으로 감춰져 있어 평탄화할 근거가 없다). 셰이프 경고도 없다.
    let engine = createJsonEngine(
      rejectTransport({ ok: false, error: { code: 'x', message: 'y' } }),
    );
    await assert.rejects(
      engine.invoke('boom', {}),
      (error: unknown) =>
        error instanceof RustraCommandError && error.code === 'unknown' && error.message.length > 0,
      'envelope-shaped rejection must normalize (not crash, not resolve)',
    );

    // 구조화 {code,message} reject — wire 표준 실패. 코드 보존이 본 계약.
    engine = createJsonEngine(rejectTransport({ code: 'x', message: 'y' }));
    await assert.rejects(
      engine.invoke('boom', {}),
      (error: unknown) =>
        error instanceof RustraCommandError &&
        error.code === 'x' &&
        error.message === 'y' &&
        error.retryable === false,
      'structured rejection must preserve code/message through normalization',
    );

    // plain Error / string reject — 역사적 fallback 계약(invoke.failed / unknown).
    engine = createJsonEngine(rejectTransport(new Error('plain boom')));
    await assert.rejects(
      engine.invoke('boom', {}),
      (error: unknown) => error instanceof RustraCommandError && error.code === 'invoke.failed',
    );
    engine = createJsonEngine(rejectTransport('string boom'));
    await assert.rejects(
      engine.invoke('boom', {}),
      (error: unknown) => error instanceof RustraCommandError && error.code === 'unknown',
    );

    assert.equal(shapes.length, 0, 'rejection path never emits response.shape');
  } finally {
    configureDebug(undefined);
    cleanup();
  }
});

// ── DX Track Task 6: 타임아웃/취소/미구성 에러 서브클래스·계약 통일 ──
// instanceof 분기 지원: TimeoutError/CancelledError 서브클래스와
// transport.unavailable 정규화. 와이어 코드·retryable·메시지는 불변.

test('timeout race rejects with TimeoutError instance across all timeout paths', async () => {
  const hanging: EngineClient = { invoke: () => new Promise(() => {}) };
  // ① invokeWithTimeout (cancel.ts)
  await assert.rejects(
    invokeWithTimeout(hanging, 'addNumbers', { a: 1 }, { timeoutMs: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof TimeoutError, 'invokeWithTimeout must throw TimeoutError');
      assert.ok(err instanceof RustraCommandError, 'TimeoutError must remain a RustraCommandError');
      assert.equal((err as TimeoutError).code, 'transport.timeout');
      assert.equal((err as TimeoutError).retryable, true);
      return true;
    },
  );

  // ② global invokeBatch timeout race (global-batch.ts)
  const sentinelBatch: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure({
    invokeBatch: () => new Promise(() => {}),
  } as unknown as EngineClient);
  try {
    await assert.rejects(
      invokeBatch<{ v: number }>([{ command: 'a', options: { timeoutMs: 20 } }]),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError, 'invokeBatch must throw TimeoutError');
        assert.equal((err as TimeoutError).code, 'transport.timeout');
        assert.equal((err as TimeoutError).retryable, true);
        return true;
      },
    );
  } finally {
    configure(sentinelBatch);
  }
});

test('invokeByIdWithTimeout rejects with TimeoutError and CancelledError instances', async () => {
  // timeout race (cancel-by-id.ts)
  const hanging: EngineClient = {
    invokeById: () => new Promise(() => {}),
  } as unknown as EngineClient;
  await assert.rejects(
    invokeByIdWithTimeout(hanging, 7, 'addNumbers', { a: 1 }, { timeoutMs: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof TimeoutError, 'invokeByIdWithTimeout must throw TimeoutError');
      assert.equal((err as TimeoutError).code, 'transport.timeout');
      assert.equal((err as TimeoutError).retryable, true);
      return true;
    },
  );

  // pre-aborted before dispatch (cancel-by-id.ts)
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    invokeByIdWithTimeout(
      {
        invoke: () => Promise.resolve(1),
      } as unknown as EngineClient,
      7,
      'addNumbers',
      undefined,
      { signal: ac.signal },
    ),
    (err: unknown) => {
      assert.ok(err instanceof CancelledError, 'pre-abort must throw CancelledError');
      assert.equal((err as CancelledError).code, 'cancelled');
      assert.equal((err as CancelledError).retryable, true);
      return true;
    },
  );

  // abort race mid-flight (cancel-by-id.ts)
  const late: EngineClient = {
    invokeById: () => new Promise(() => {}),
  } as unknown as EngineClient;
  const controller = new AbortController();
  const p = invokeByIdWithTimeout(late, 7, 'addNumbers', undefined, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof CancelledError, 'abort race must throw CancelledError');
    assert.equal((err as CancelledError).code, 'cancelled');
    return true;
  });
});

test('raceAbort and invokeCallbackWithAbort reject with CancelledError instances', async () => {
  // raceAbort (cancel-abort.ts)
  const controller = new AbortController();
  const raced = raceAbort(new Promise(() => {}), controller.signal, 'cancel-me');
  controller.abort();
  await assert.rejects(raced, (err: unknown) => {
    assert.ok(err instanceof CancelledError, 'raceAbort must throw CancelledError');
    assert.equal((err as CancelledError).code, 'cancelled');
    assert.equal((err as CancelledError).retryable, true);
    return true;
  });

  // invokeCallbackWithAbort: pre-aborted before dispatch (cancel.ts)
  await assert.rejects(
    invokeCallbackWithAbort('cancel-me', AbortSignal.abort(), () => {
      throw new Error('dispatch must not run when already aborted');
    }),
    (err: unknown) => {
      assert.ok(err instanceof CancelledError, 'callback pre-abort must throw CancelledError');
      assert.equal((err as CancelledError).code, 'cancelled');
      return true;
    },
  );

  // invokeCallbackWithAbort: abort mid-flight (cancel.ts)
  const mid = new AbortController();
  const pending = invokeCallbackWithAbort<void>('cancel-me', mid.signal, () => {
    /* dispatch settles nothing — abort must win */
  });
  mid.abort();
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof CancelledError, 'callback abort mid-flight must throw CancelledError');
    assert.equal((err as CancelledError).code, 'cancelled');
    return true;
  });
});

test('engine-level pre-aborted invoke and invokeById reject with CancelledError', async () => {
  // rkyv-engine-surface.ts invokeById pre-abort + invokeRaw pre-abort paths.
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 1 }]),
    invokeImpl: () => {
      throw new Error('native must not be called when already aborted');
    },
  });
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(engine.invoke('dyn', {}, { signal: ac.signal }), (e: unknown) => {
    assert.ok(e instanceof CancelledError, 'engine.invoke pre-abort must throw CancelledError');
    assert.equal((e as CancelledError).code, 'cancelled');
    return true;
  });
  await assert.rejects(engine.invokeById(1, 'dyn', {}, { signal: ac.signal }), (e: unknown) => {
    assert.ok(e instanceof CancelledError, 'engine.invokeById pre-abort must throw CancelledError');
    assert.equal((e as CancelledError).code, 'cancelled');
    return true;
  });
});

test('unconfigured invoke rejects with RustraCommandError transport.unavailable', async () => {
  // sentinel이 호출되면 이전 테스트 오염을 즉시 드러낸다.
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    // runtime.engine === null && runtime.engineInitializer === undefined 상태를
    // 만들기 위해 configureLazy의 initializer를 지운다 — public API로는
    // configure(null 엔진) 없이는 불가하므로 내부 runtime에 직접 접근한다.
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    const returned = invoke('dyn', { a: 1 });
    assert.ok(returned instanceof Promise, 'unconfigured invoke must return a Promise');
    await assert.rejects(returned, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      assert.equal((err as RustraCommandError).retryable, false);
      assert.match((err as Error).message, /Rustra not configured/);
      return true;
    });
  } finally {
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    runtime.engineInitialization = undefined;
    resetConfiguredRoutes();
    configure(sentinel);
  }
});

test('unconfigured invokeGenerated and invokeGeneratedFields reject instead of sync throw', async () => {
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    runtime.engineInitialization = undefined;
    resetConfiguredRoutes();

    // ④ invokeGenerated — 계약 통일: sync throw 금지, rejected Promise.
    const gen = invokeGenerated<{ v: number }>(1, 'dyn');
    assert.ok(gen instanceof Promise, 'unconfigured invokeGenerated must return a Promise');
    await assert.rejects(gen, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      assert.equal((err as RustraCommandError).retryable, false);
      return true;
    });

    // invokeGeneratedFields (global-fields.ts) — 동일 codegen 계약.
    const fields = invokeGeneratedFields2<{ v: number }>(1, 'dyn', { a: 1 }, 1, 2);
    assert.ok(fields instanceof Promise, 'unconfigured invokeFields must return a Promise');
    await assert.rejects(fields, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      return true;
    });

    // invokeGeneratedBytes (global-bytes.ts) — 동일 codegen 계약.
    const bytes = invokeGeneratedBytes(1, 'dyn', { data: new ArrayBuffer(0) }, new ArrayBuffer(0));
    assert.ok(bytes instanceof Promise, 'unconfigured invokeGeneratedBytes must return a Promise');
    await assert.rejects(bytes, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      return true;
    });
  } finally {
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    runtime.engineInitialization = undefined;
    resetConfiguredRoutes();
    configure(sentinel);
  }
});

test('unconfigured invokeBatch and ensureConfigured reject with transport.unavailable', async () => {
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    runtime.engineInitialization = undefined;
    resetConfiguredRoutes();

    // invokeBatch (global-batch.ts)
    const batch = invokeBatch<{ v: number }>([{ command: 'a' }]);
    assert.ok(batch instanceof Promise, 'unconfigured invokeBatch must return a Promise');
    await assert.rejects(batch, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      return true;
    });

    // ensureConfigured (global-config.ts) — RN lazy entry 힌트 메시지 보존.
    await assert.rejects(ensureConfigured(), (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.unavailable');
      assert.match((err as Error).message, /React Native entry/);
      return true;
    });
  } finally {
    runtime.engine = null;
    runtime.engineInitializer = undefined;
    runtime.engineInitialization = undefined;
    resetConfiguredRoutes();
    configure(sentinel);
  }
});

// ── R04: 와이어 배치 옵션·정규화·동기 throw 계약 통일 ─────────────
// json-engine 의 단일 횡단(invokeBatch) 경로가 단건 invoke 경로와 세 계약에서
// 갈라졌다: ① timeoutMs truthiness 판정(0 이 누락), ② transport 동기 throw 가
// Promise.reject 로 정규화되지 않음, ③ normalizeArgs 미적용. 아래 회귀 표는
// 각 사례를 와이어 배치 경로(transport.invokeBatch 제공)와 글로벌 파사드
// (configure + invokeBatch) 양쪽에서 모두 핀한다 — 두 경로의 결과가 동일해야 한다.

/** R04 테스트용 — 지연 resolve 하는 단일 횡단 배치 transport. */
function delayedWireBatchTransport(delayMs: number): {
  invoke: (command: string, args?: unknown) => Promise<unknown>;
  invokeBatch: (requests: BatchEntry[]) => Promise<unknown[]>;
} {
  return {
    invoke: async (command, args) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { command, args };
    },
    invokeBatch: async (requests) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return requests.map((entry) => ({ ok: true, command: entry.command }));
    },
  };
}

test('wire batch timeoutMs 0 takes the per-entry timeout path like the single invoke (R04-a)', async () => {
  const engine = createJsonEngine(delayedWireBatchTransport(50));
  // 단건 경로(cancel.ts): timeoutMs 0 은 "옵션 제공"으로 판정되어 즉시
  // transport.timeout reject. 와이어 배치 게이트도 동일 판정이어야 한다 —
  // truthiness 검사면 0 이 falsy 로 누락되어 50ms 지연 응답이 resolve 된다.
  await assert.rejects(
    engine.invoke('slow', {}, { timeoutMs: 0 }),
    (err: unknown) => err instanceof TimeoutError && err.code === 'transport.timeout',
    'single invoke: timeoutMs 0 must time out immediately',
  );
  await assert.rejects(
    engine.invokeBatch<number>([{ command: 'slow', args: {}, options: { timeoutMs: 0 } }]),
    (err: unknown) => err instanceof TimeoutError && err.code === 'transport.timeout',
    'wire batch: timeoutMs 0 must fall back to the per-entry timeout path',
  );
});

test('wire batch options object without timeoutMs still rides the single crossing (R04-a nuance)', async () => {
  // 판정은 "timeoutMs !== undefined" — options 객체가 있어도 timeoutMs 가
  // undefined 면 항목별 타임아웃 경로로 보내지 않는다(단건 경로 계약 —
  // undefined timeout 은 레이스 없음). signal 도 없으니 와이어 단일 횡단 유지.
  let batchCalls = 0;
  const transport = delayedWireBatchTransport(0);
  const engine = createJsonEngine({
    invoke: transport.invoke,
    invokeBatch: (requests) => {
      batchCalls++;
      return transport.invokeBatch(requests);
    },
  });
  const out = await engine.invokeBatch([{ command: 'a', options: {} }]);
  assert.equal(batchCalls, 1, 'empty options must not knock the batch off the wire crossing');
  assert.deepEqual(out, [{ ok: true, command: 'a' }]);
});

test('wire batch turns a synchronous transport throw into a rejected Promise (R04-b)', async () => {
  // 단건 경로(json-engine invoke)는 transport 동기 throw 를 catch 해서
  // Promise.reject(normalizeRustraError(error)) 로 정규화한다. 배치 경로도
  // 동일해야 한다 — 동기 throw 는 호출자의 try/catch 를 건너뛰는 계약 위반이다.
  const engine = createJsonEngine({
    invoke: () => Promise.resolve('unused'),
    invokeBatch: () => {
      throw { code: 'transport.error', message: 'wire batch blew up', retryable: true };
    },
  });
  const returned = engine.invokeBatch([{ command: 'a' }, { command: 'b' }]);
  assert.ok(returned instanceof Promise, 'sync throw must not escape invokeBatch');
  await assert.rejects(returned, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError, 'must pass through normalizeRustraError');
    assert.equal((err as RustraCommandError).code, 'transport.error');
    assert.equal((err as RustraCommandError).message, 'wire batch blew up');
    assert.equal((err as RustraCommandError).retryable, true);
    return true;
  });

  // plain Error 동기 throw — normalizeRustraError 의 fallback 계약(invoke.failed).
  const plainEngine = createJsonEngine({
    invoke: () => Promise.resolve('unused'),
    invokeBatch: () => {
      throw new Error('sync boom');
    },
  });
  await assert.rejects(
    plainEngine.invokeBatch([{ command: 'a' }]),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'invoke.failed',
  );
});

test('wire batch throwing custom normalizer converges to a rejection like the single path (R04-c)', async () => {
  // normalizeArgs 는 주입된 사용자 코드다 — 정규화 맵이 try 경계 밖에 있으면
  // normalizer 의 동기 throw 가 호출자 try/catch 를 건너뛴다. 단건 경로는 같은
  // 실패를 rejected Promise 로 정규화하므로 배치 경로도 동일해야 한다.
  const engine = createJsonEngine(
    {
      invoke: () => Promise.resolve('unused'),
      invokeBatch: () => [],
    },
    () => {
      throw new Error('normalizer exploded');
    },
  );
  const returned = engine.invokeBatch([{ command: 'a' }]);
  assert.ok(returned instanceof Promise, 'normalizer sync throw must not escape invokeBatch');
  await assert.rejects(returned, (err: unknown) => {
    assert.ok(err instanceof RustraCommandError, 'must pass through normalizeRustraError');
    assert.equal((err as RustraCommandError).code, 'invoke.failed');
    assert.match((err as Error).message, /normalizer exploded/);
    return true;
  });
});

test('wire batch entry with combined signal and timeoutMs 0 keeps per-entry fallback (R04-a table row)', async () => {
  // signal + timeoutMs 0 조합 — 두 옵션이 모두 "제공됨"으로 판정되어 폴백 경로로
  // 간다. 폴백은 단건 경로(cancel.ts)와 같은 판정이므로 timeoutMs 0 이 즉시
  // transport.timeout 을 내고 signal abort 는 그 앞에서 cancelled 를 낼 수 있다.
  let batchCalls = 0;
  const controller = new AbortController();
  const engine = createJsonEngine({
    invoke: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'late';
    },
    invokeBatch: () => {
      batchCalls++;
      return [];
    },
  });
  await assert.rejects(
    engine.invokeBatch([{ command: 'slow', options: { signal: controller.signal, timeoutMs: 0 } }]),
    (err: unknown) => err instanceof TimeoutError && err.code === 'transport.timeout',
    'combined options must take the per-entry fallback and honor timeoutMs 0',
  );
  assert.equal(batchCalls, 0, 'combined options must knock the batch off the wire crossing');
});

test('wire batch extra entry properties survive the normalized recreation (R04-c table row)', async () => {
  // { ...entry, args } 재생성이 BatchEntry 계약 밖의 추가 프로퍼티를 보존하는지
  // 핀 — transport 가 커스텀 메타데이터에 의존해도 정규화가 이를 훼손하지 않는다.
  const seenRequests: Array<{ command: string; meta?: unknown }> = [];
  const engine = createJsonEngine({
    invoke: () => Promise.resolve('unused'),
    invokeBatch: (requests) => {
      for (const request of requests) {
        seenRequests.push({ command: request.command, meta: (request as { meta?: unknown }).meta });
      }
      return requests.map(() => ({ ok: true }));
    },
  });
  const entries = [
    { command: 'a', args: undefined, meta: 'keep-me' },
    { command: 'b', args: { v: 1 }, meta: { nested: true } },
  ] as unknown as BatchEntry[];
  const out = await engine.invokeBatch(entries);
  assert.deepEqual(out, [{ ok: true }, { ok: true }]);
  assert.deepEqual(seenRequests, [
    { command: 'a', meta: 'keep-me' },
    { command: 'b', meta: { nested: true } },
  ]);
});

test('wire batch applies normalizeArgs per entry without mutating the original entries (R04-c)', async () => {
  // tauri 어댑터 계약과 동일 — normalizeArgs: undefined → {}. 와이어 배치도
  // 항목별 args 를 정규화해서 transport 에 건네야 한다(단건 경로는 이미 적용).
  // 원본 entries 배열과 항목 객체는 절대 변형하지 않는다(global-batch 의
  // stripped 패턴과 동일한 재생성 관례).
  const seenRequests: Array<{ command: string; args: unknown }> = [];
  const engine = createJsonEngine(
    {
      invoke: () => Promise.resolve('unused'),
      invokeBatch: (requests) => {
        for (const request of requests) {
          seenRequests.push({ command: request.command, args: request.args });
        }
        return requests.map(() => ({ ok: true }));
      },
    },
    (args) => args ?? { normalized: true },
  );
  const originalFirst: BatchEntry = { command: 'a' };
  const originalSecond: BatchEntry = { command: 'b', args: undefined };
  const entries = [originalFirst, originalSecond];
  const out = await engine.invokeBatch(entries);
  assert.deepEqual(out, [{ ok: true }, { ok: true }]);
  assert.deepEqual(
    seenRequests,
    [
      { command: 'a', args: { normalized: true } },
      { command: 'b', args: { normalized: true } },
    ],
    'each entry args must be normalized before the wire crossing',
  );
  // 원본 무변형 핀 — 항목 객체를 재생성하지 않고 흔들면 호출자 계약이 깨진다.
  assert.deepEqual(originalFirst, { command: 'a' });
  assert.deepEqual(originalSecond, { command: 'b', args: undefined });
  assert.deepEqual(entries, [{ command: 'a' }, { command: 'b', args: undefined }]);
});

test('wire batch mixed-signal entries keep the per-entry fallback path (R04 regression guard)', async () => {
  // signal 항목이 섞이면 기존 폴백(항목별 invokeWithTimeout) — 단일 횡단 금지.
  let batchCalls = 0;
  let singleCalls = 0;
  const controller = new AbortController();
  const engine = createJsonEngine({
    invoke: (command, args) => {
      singleCalls++;
      return Promise.resolve({ command, args });
    },
    invokeBatch: () => {
      batchCalls++;
      return [];
    },
  });
  const out = await engine.invokeBatch([
    { command: 'a' },
    { command: 'b', options: { signal: controller.signal } },
  ]);
  assert.equal(batchCalls, 0, 'signal entry must knock the batch off the wire crossing');
  assert.equal(singleCalls, 2, 'fallback must route each entry through invokeWithTimeout');
  assert.deepEqual(out, [
    { command: 'a', args: undefined },
    { command: 'b', args: undefined },
  ]);
});

test('wire batch empty entries resolves to an empty array on the single crossing (regression guard)', async () => {
  let batchCalls = 0;
  const engine = createJsonEngine({
    invoke: () => Promise.resolve('unused'),
    invokeBatch: (requests) => {
      batchCalls++;
      return requests.map(() => ({}));
    },
  });
  const out = await engine.invokeBatch([]);
  assert.deepEqual(out, []);
  assert.equal(batchCalls, 1, 'empty batch must still use the single crossing, not the fallback');
});

// ── R04: 글로벌 파사드(invokeBatch)와의 경로 동일성 ─────────────
// 와이어 배치 엔진을 configure 해서 글로벌 invokeBatch 로 같은 사례를 돌린다 —
// 두 경로의 관찰 결과가 동일해야 한다(경로별 갈라짐이 재발하면 이 표가 잡는다).

test('global invokeBatch matches the wire batch on timeout 0, sync throw, and normalization (R04)', async () => {
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    // ① timeoutMs 0 → 항목별 폴백 경로의 즉시 transport.timeout (단건 경로와
    // 동일 판정. 글로벌 최소 timeout 레이스 정책은 불변 — 이 사례는 timeout
    // 최솟값 계산과 무관하게 항목 options 를 존중하는 폴백으로 간다).
    const delayedEngine = createJsonEngine(delayedWireBatchTransport(50));
    configure(delayedEngine as unknown as EngineClient);
    await assert.rejects(
      invokeBatch([{ command: 'slow', args: {}, options: { timeoutMs: 0 } }]),
      (err: unknown) => err instanceof TimeoutError && err.code === 'transport.timeout',
      'global path: timeoutMs 0 must behave like the wire batch path',
    );

    // ② transport 동기 throw → rejected Promise + 정규화.
    const throwingEngine = createJsonEngine({
      invoke: () => Promise.resolve('unused'),
      invokeBatch: () => {
        throw { code: 'transport.error', message: 'wire batch blew up', retryable: true };
      },
    });
    configure(throwingEngine as unknown as EngineClient);
    const returned = invokeBatch([{ command: 'a' }]);
    assert.ok(returned instanceof Promise, 'global path: sync throw must not escape');
    await assert.rejects(returned, (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.error');
      assert.equal((err as RustraCommandError).message, 'wire batch blew up');
      assert.equal((err as RustraCommandError).retryable, true);
      return true;
    });

    // ③ normalizeArgs 항목별 적용 — 글로벌 파사드가 엔진 위에서 정규화를
    // 우회하지 않는다(정규화는 엔진 내부 배선).
    const seenRequests: Array<{ command: string; args: unknown }> = [];
    const normalizingEngine = createJsonEngine(
      {
        invoke: () => Promise.resolve('unused'),
        invokeBatch: (requests) => {
          for (const request of requests) {
            seenRequests.push({ command: request.command, args: request.args });
          }
          return requests.map(() => ({ ok: true }));
        },
      },
      (args) => args ?? { normalized: true },
    );
    configure(normalizingEngine as unknown as EngineClient);
    const out = await invokeBatch([{ command: 'a' }, { command: 'b', args: undefined }]);
    assert.deepEqual(out, [{ ok: true }, { ok: true }]);
    assert.deepEqual(seenRequests, [
      { command: 'a', args: { normalized: true } },
      { command: 'b', args: { normalized: true } },
    ]);
  } finally {
    configure(sentinel);
  }
});

test('global invokeBatch empty entries resolves to an empty array (regression guard)', async () => {
  const engine = createJsonEngine({
    invoke: () => Promise.resolve('unused'),
    invokeBatch: (requests) => requests.map(() => ({})),
  });
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(engine as unknown as EngineClient);
  try {
    assert.deepEqual(await invokeBatch([]), []);
  } finally {
    configure(sentinel);
  }
});

test('global invokeBatch mixed-signal entries keep the per-entry fallback (regression guard)', async () => {
  // signal 전용 항목(timeoutMs 없음)은 글로벌 최소 timeout 레이스를 만들지 않고
  // 엔진의 폴백 경로로 그대로 통과해야 한다 — 엔진 내부 판정과 파사드가 갈라지면
  // 이 표가 잡는다.
  let batchCalls = 0;
  let singleCalls = 0;
  const controller = new AbortController();
  const engine = createJsonEngine({
    invoke: (command, args) => {
      singleCalls++;
      return Promise.resolve({ command, args });
    },
    invokeBatch: () => {
      batchCalls++;
      return [];
    },
  });
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  configure(engine as unknown as EngineClient);
  try {
    const out = await invokeBatch([
      { command: 'a' },
      { command: 'b', options: { signal: controller.signal } },
    ]);
    assert.equal(batchCalls, 0, 'facade path: signal entry must knock the batch off the crossing');
    assert.equal(singleCalls, 2, 'facade path: fallback routes each entry through invoke');
    assert.deepEqual(out, [
      { command: 'a', args: undefined },
      { command: 'b', args: undefined },
    ]);
  } finally {
    configure(sentinel);
  }
});

// ── R05: dispatch 중 동기 abort 관측 — listener 등록 직후 재검사 ──
// cancel.ts / cancel-by-id.ts 의 abort 레이스는 dispatch 가 끝난 뒤에 리스너를
// 등록한다. transport 의 invoke 가 동기 구간 안에서 controller.abort() 를 부르고
// 정상 resolve 하면, abort 이벤트는 리스너 등록 전에 이미 지나갔고
// addEventListener 는 이미 중단된 signal 에서 이벤트를 재발화하지 않는다 —
// 취소가 소실되고 resolve 가 이긴다. 등록 직후 signal.aborted 재검사 + 선정착
// (early-settle) 레이스가 이 갭을 닫는다. 지연 transport + 호출 카운터로
// 제어한다(실제 sleep 없음).

/** R05 테스트용 — dispatch 를 카운트하고 즉시 resolve 하는 transport. */
function resolvingCancelTransport(calls: { dispatches: number }): {
  invoke<T>(command: string, args?: unknown): Promise<T>;
} {
  return {
    invoke<T>(command: string, _args?: unknown): Promise<T> {
      calls.dispatches++;
      return Promise.resolve(`ok:${command}` as unknown as T);
    },
  };
}

test('R05 invokeWithTimeout: dispatch 중 동기 abort 는 취소로 정착한다', async () => {
  // 핵심 신규 사례: invoke 내부에서 abort → 정상 resolve. 리스너 등록이 dispatch
  // 뒤에 있으므로 이벤트는 이미 발화됐다 — 재검사 없으면 resolve 가 이긴다.
  const calls = { dispatches: 0 };
  const ac = new AbortController();
  const transport = resolvingCancelTransport(calls);
  const engine: EngineClient = {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const dispatching = transport.invoke<T>(command, args);
      ac.abort(); // dispatch 동기 구간 안에서 abort
      return dispatching;
    },
  };
  await assert.rejects(
    invokeWithTimeout(engine, 'sync-abort', undefined, { signal: ac.signal }),
    (err: unknown) => err instanceof CancelledError && err.code === 'cancelled',
    'sync abort inside dispatch must be observed and reject with cancelled',
  );
  assert.equal(calls.dispatches, 1, 'dispatch must have happened exactly once');
});

test('R05 invokeByIdWithTimeout: dispatch 중 동기 abort 는 취소로 정착한다', async () => {
  const calls = { dispatches: 0 };
  const ac = new AbortController();
  const transport = resolvingCancelTransport(calls);
  const engine: EngineClient = {
    invokeById<T>(commandId: number, command: string, args?: unknown): Promise<T> {
      void commandId;
      const dispatching = transport.invoke<T>(command, args);
      ac.abort(); // dispatch 동기 구간 안에서 abort
      return dispatching;
    },
  } as unknown as EngineClient;
  await assert.rejects(
    invokeByIdWithTimeout(engine, 7, 'sync-abort', undefined, { signal: ac.signal }),
    (err: unknown) => err instanceof CancelledError && err.code === 'cancelled',
    'sync abort inside dispatch must be observed and reject with cancelled',
  );
  assert.equal(calls.dispatches, 1, 'dispatch must have happened exactly once');
});

test('R05 회귀 가드: pre-abort 는 0 dispatch 로 즉시 거부한다', async () => {
  // 기존 fast path — 재검사 추가가 이 경로를 흔들면 안 된다.
  let dispatches = 0;
  const ac = new AbortController();
  ac.abort();
  const engine: EngineClient = {
    invoke<T>(): Promise<T> {
      dispatches++;
      return new Promise<T>(() => {});
    },
  };
  await assert.rejects(
    invokeWithTimeout(engine, 'pre-abort', undefined, { signal: ac.signal }),
    (err: unknown) => err instanceof CancelledError && /aborted before dispatch/.test(err.message),
    'pre-abort must reject with the before-dispatch message',
  );
  assert.equal(dispatches, 0, 'pre-abort must never dispatch');
});

test('R05 회귀 가드: in-flight 비동기 abort 는 기존대로 취소한다', async () => {
  // dispatch 이후 promise settle 전에 abort — 기존 이벤트 경로.
  let resolveDispatch!: (v: string) => void;
  let dispatches = 0;
  const ac = new AbortController();
  const engine: EngineClient = {
    invoke<T>(): Promise<T> {
      dispatches++;
      return new Promise<T>((resolve) => {
        resolveDispatch = resolve as (v: string) => void;
      });
    },
  };
  const pending = invokeWithTimeout(engine, 'in-flight', undefined, { signal: ac.signal });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  ac.abort();
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof CancelledError && err.code === 'cancelled',
    'async mid-flight abort must still reject with cancelled',
  );
  assert.equal(dispatches, 1);
  resolveDispatch('late'); // 지각 응답 — 흡수되어야 함
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});

test('R05 회귀 가드: 정상 완료 후 abort 는 결과를 바꾸지 않는다', async () => {
  const calls = { dispatches: 0 };
  const ac = new AbortController();
  const engine: EngineClient = {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      return resolvingCancelTransport(calls).invoke<T>(command, args);
    },
  };
  const settled = await invokeWithTimeout<string>(engine, 'done', undefined, {
    signal: ac.signal,
  });
  ac.abort(); // 완료 뒤 abort — 리스너는 이미 제거됐다
  assert.equal(settled, 'ok:done', 'abort after completion must not alter the result');
  assert.equal(calls.dispatches, 1);
});

test('R05 정착 일변성: 동기 abort 재검사는 resolve 와의 경쟁에서 정확히 한 번 이긴다', async () => {
  // 재진입: dispatch 가 이중 abort 를 부르고 정상 resolve 까지 반환한다.
  // settle-once 의 관측 증거 — cancel 이 정착한 뒤 resolve 리스너가 절대
  // 실행되지 않는다. 이미 fulfill 된 promise 가 races[0] 로 먼저 연결되면
  // Promise.race 는 동시 정착에서 그쪽을 이기게 하므로, 재검사가 이 테스트를
  // 이기려면 race 참여가 아니라 선정착 반환이어야 한다는 것이 이 테스트가
  // 존재하는 이유이다.
  const calls = { dispatches: 0 };
  const ac = new AbortController();
  const engine: EngineClient = {
    invoke<T>(command: string): Promise<T> {
      calls.dispatches++;
      const dispatching = Promise.resolve(`ok:${command}` as unknown as T);
      ac.abort();
      ac.abort(); // 이중 abort — 두 번째는 no-op
      return dispatching;
    },
  };
  let resolved = 0;
  const pending = invokeWithTimeout(engine, 'double-abort', undefined, { signal: ac.signal });
  const watched = pending.then(
    () => {
      resolved++;
      return 'resolved';
    },
    (err: unknown) => {
      assert.ok(err instanceof CancelledError, 'settlement must be the cancel rejection');
      return 'cancelled';
    },
  );
  assert.equal(await watched, 'cancelled');
  assert.equal(resolved, 0, 'resolve callback must never run once cancel has settled');
  assert.equal(calls.dispatches, 1);
});

test('R05 정리 경로: 정착 후 abort 리스너가 정확히 한 번 제거된다', async () => {
  // 기존 cleanup path 보존 — in-flight abort 로 정착한 뒤 finally 정리가
  // 리스너를 제거해야 한다. removeEventListener 스파이로 직접 증명한다.
  // (동기 abort 재검사 경로는 애초에 리스너를 등록하지 않으므로 이 테스트의
  // 대상이 아니다 — 선정착 반환이 정리를 필요로 하지 않는다.)
  const ac = new AbortController();
  let removals = 0;
  let registeredFn: unknown;
  let removedFn: unknown;
  const origAdd = ac.signal.addEventListener.bind(ac.signal);
  ac.signal.addEventListener = (...args: Parameters<typeof origAdd>) => {
    if (args[0] === 'abort') registeredFn = args[1];
    return origAdd(...args);
  };
  const origRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.removeEventListener = (...args: Parameters<typeof origRemove>) => {
    if (args[0] === 'abort') {
      removals++;
      removedFn = args[1];
    }
    return origRemove(...args);
  };
  const engine: EngineClient = {
    invoke<T>(): Promise<T> {
      return new Promise<T>(() => {});
    },
  };
  const pending = invokeWithTimeout(engine, 'cleanup', undefined, { signal: ac.signal });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  ac.abort();
  await assert.rejects(pending, (err: unknown) => err instanceof CancelledError);
  // finally 정리가 돌 때까지 마이크로태스크 대기.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(removals, 1, 'abort listener must be removed exactly once after settlement');
  assert.ok(
    typeof registeredFn === 'function' && removedFn === registeredFn,
    'the removed fn must be the registered abort listener itself',
  );
});

test('R05 배치 폴백: 와이어 배치 항목의 동기 abort 도 취소로 정착한다', async () => {
  // 배치 폴백은 항목별 invokeWithTimeout 을 태운다(cancel.ts) — 케이스 2가
  // 폴백을 통해서도 관측되는지 암묵적 핀. signal 항목이 단일 횡단을 깨는 것은
  // 기존 R04 회귀 표가 담당한다.
  const ac = new AbortController();
  let dispatches = 0;
  const engine = createJsonEngine({
    invoke<T>(command: string): Promise<T> {
      dispatches++;
      if (command === 'boom') ac.abort(); // dispatch 동기 구간 안에서 abort
      return Promise.resolve(`ok:${command}` as unknown as T);
    },
  });
  await assert.rejects(
    engine.invokeBatch([{ command: 'calm' }, { command: 'boom', options: { signal: ac.signal } }]),
    (err: unknown) => err instanceof CancelledError && err.code === 'cancelled',
    'batch fallback: sync abort inside dispatch must reject the whole batch with cancelled',
  );
  assert.equal(dispatches, 2, 'both entries must have dispatched (Promise.all semantics)');
});

test('R05 흡수 보장: 선정착 반환이 나중에 reject 하는 dispatch promise 를 흡수한다', async () => {
  // 재검사 reject 로 선정착 반환할 때 dispatch promise 의 reject 흡수자가 이미
  // 붙어 있어야 한다 — transport 가 abort 중 reject 하면 지각 rejection 이
  // unhandled rejection 이 되어 프로세스가 죽는다(레이스 경로와 동일 보장).
  const ac = new AbortController();
  const engine: EngineClient = {
    invoke<T>(command: string): Promise<T> {
      ac.abort(); // dispatch 동기 구간 안에서 abort
      return Promise.reject(new Error(`late rejection from ${command}`));
    },
  };
  await assert.rejects(
    invokeWithTimeout(engine, 'late-reject', undefined, { signal: ac.signal }),
    (err: unknown) => err instanceof CancelledError && err.code === 'cancelled',
    'early settle must win over the late dispatch rejection',
  );
  // 지각 rejection 이 여기서 터지면 테스트 프로세스가 죽는다 — 흡수 증명.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

// ── R07: 통합 문서 도착 검증 — 에러 승격·cause 보존 축 ─────────────
// dx 트랙(DX Track Task 6)이 timeout→TimeoutError, cancel→CancelledError,
// pre-abort 승격을 착지시켰다. 이 절은 그 착지의 통합 문서(T09) 회귀 축만
// 고정한다 — 승격 로직 자체는 errors.ts 기존 구현 그대로(회귀 고정).

test('R07 도착: wire 구조화 transport.timeout rejection 을 전역 invoke 파사드가 TimeoutError 로 승격한다', async () => {
  // json-engine 의 .catch(normalizeRustraError) 배선 → errors.ts 승격 →
  // cancel.ts 레이스 경유. instanceof 분기가 파사드 경로 끝까지 살아있는지.
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    configure(
      createJsonEngine({
        invoke: () => Promise.reject({ code: 'transport.timeout', message: 'wire timed out' }),
      }),
    );
    await assert.rejects(invoke('slow', { a: 1 }), (err: unknown) => {
      assert.ok(err instanceof TimeoutError, 'wire timeout must surface as TimeoutError');
      assert.ok(err instanceof RustraCommandError, 'TimeoutError must stay a RustraCommandError');
      assert.equal((err as TimeoutError).code, 'transport.timeout');
      assert.equal((err as TimeoutError).retryable, true, 'wire retryable must be derived');
      assert.match((err as Error).message, /wire timed out/);
      return true;
    });
  } finally {
    configure(sentinel);
  }
});

test('R07 도착: 전역 invokeBatch timeout race 는 TimeoutError 로 정착한다', async () => {
  // global-batch.ts 의 최솟값 레이스 — 지각 배치 결과는 버려지고 레이스 승자는
  // TimeoutError 서브클래스여야 한다(dx ② 재확인: 최종 소비자 관점).
  const sentinel: EngineClient = {
    invoke(): Promise<never> {
      throw new Error('sentinel engine: global engine leaked from a previous test');
    },
  } as unknown as EngineClient;
  try {
    let batchCrossings = 0;
    configure({
      invokeBatch: <T>(): Promise<T[]> => {
        batchCrossings++;
        return new Promise<T[]>((resolve) => setTimeout(() => resolve([1, 2]), 500));
      },
    } as unknown as EngineClient);
    const startedAt = Date.now();
    await assert.rejects(
      invokeBatch<number>([{ command: 'a', options: { timeoutMs: 20 } }]),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError, 'batch race must settle with TimeoutError');
        assert.equal((err as TimeoutError).code, 'transport.timeout');
        assert.equal((err as TimeoutError).retryable, true);
        assert.match((err as Error).message, /timed out/);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 500, 'the race must reject at the timeout, not the late batch');
    assert.equal(batchCrossings, 1, 'exactly one batch crossing is issued');
  } finally {
    configure(sentinel);
  }
});

test('R07 도착: 승격된 서브클래스도 cause 와 retryable 을 보존한다', async () => {
  // errors.ts 승격 경로 — 원본 wire 객체가 cause 로 남고 retryable 유실이
  // 없어야 재시도·원인 추적 코드가 instanceof 경로에서도 동작한다.
  const wire = { code: 'transport.timeout', message: 'backend died', retryable: true };
  const promoted = normalizeRustraError(wire);
  assert.ok(promoted instanceof TimeoutError);
  assert.equal(promoted.cause, wire, 'the original wire object must remain the cause');
  assert.equal(promoted.retryable, true);
  assert.equal(promoted.code, 'transport.timeout');

  const cancelledWire = { code: 'cancelled', message: 'host aborted' };
  const cancelled = normalizeRustraError(cancelledWire);
  assert.ok(cancelled instanceof CancelledError);
  assert.equal(cancelled.cause, cancelledWire);
  assert.equal(cancelled.retryable, true, 'cancelled code implies retryable');
  assert.equal(cancelled.code, 'cancelled');
});

test('R07 회귀: 사용자 code 커스텀 RustraCommandError 는 normalize 를 통과해도 원본이 보존된다', async () => {
  // 정책 — normalizeRustraError 의 instanceof fast-path: 이미 RustraCommandError
  // (및 서브클래스)인 값은 절대 재생성하지 않는다. 사용자가 code 를 커스텀한
  // 인스턴스를 transport 가 그대로 reject 해도 객체 동일성·코드·retryable 이
  // 유지된다. json-engine 배선을 통해서도 동일(정규화 관통).
  const custom = new RustraCommandError('order.conflict', 'order 42 already shipped', true);
  const passedThrough = normalizeRustraError(custom);
  assert.equal(passedThrough, custom, 'RustraCommandError instances must pass through untouched');
  assert.equal(passedThrough.code, 'order.conflict');
  assert.equal(passedThrough.retryable, true);

  // json-engine rejection 배선 — transport 가 서브클래스를 reject 해도 동일.
  const engine = createJsonEngine({ invoke: () => Promise.reject(custom) });
  await assert.rejects(engine.invoke('ship', {}), (err: unknown) => {
    assert.equal(err, custom, 'engine rejection must preserve the caller error by identity');
    return true;
  });

  // 서브클래스도 동일 — TimeoutError 를 reject 하면 재래핑 없이 그대로.
  const timeout = new TimeoutError('custom timeout instance');
  const engine2 = createJsonEngine({ invoke: () => Promise.reject(timeout) });
  await assert.rejects(engine2.invoke('slow', {}), (err: unknown) => {
    assert.equal(err, timeout);
    return true;
  });
});
