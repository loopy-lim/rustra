// createRkyvV2Engine Tier 3 fallback + getLiveSchema 단위 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configure,
  createRkyvV2Engine,
  getLiveSchema,
  invoke,
  RustraCommandError,
  parseRustraErrorString,
} from './index.js';
import type { RkyvV2SchemaNative, RkyvV2Codec, BatchEntry, EngineClient } from './index.js';

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
  commands: Array<{ name: string; commandId: number }>,
  schemaVersion?: number,
): ArrayBuffer {
  const doc: Record<string, unknown> =
    schemaVersion !== undefined
      ? { packageId: 't', schemaVersion, commands }
      : { packageId: 't', commands };
  return bytesFromStrings([JSON.stringify(doc)]);
}

interface NativeOpts {
  schema?: ArrayBuffer;
  invokeImpl?: (payload: ArrayBuffer) => ArrayBuffer;
  /** 네이티브가 노출하는 계약 해시(F5). undefined 면 getContractHash 를 노출하지 않는다. */
  contractHash?: string;
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

test('getLiveSchema returns empty map when getSchema missing', () => {
  const native = { invokeRkyvV2: () => new ArrayBuffer(0) } as RkyvV2SchemaNative;
  const map = getLiveSchema(native);
  assert.equal(map.size, 0);
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

/** makeNative 결과에 typed 코덱 메서드를 붙인 네이티브를 만든다. */
function makeTypedNative(
  opts: NativeOpts & {
    hasStaticCodec?: (name: string) => boolean;
    invokeTyped?: (name: string, args: unknown) => unknown;
    invokeTypedBatch?: (names: string[], args: unknown[]) => unknown[];
  },
): RkyvV2SchemaNative {
  const base = makeNative(opts);
  const typed: RkyvV2SchemaNative = { ...base };
  if (opts.hasStaticCodec) typed.hasStaticCodec = opts.hasStaticCodec;
  if (opts.invokeTyped) typed.invokeTyped = opts.invokeTyped;
  if (opts.invokeTypedBatch) typed.invokeTypedBatch = opts.invokeTypedBatch;
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
  const engine = createRkyvV2Engine(native, new Map());
  await assert.rejects(
    async () => {
      await engine.invoke('add', {});
    },
    (err: Error) => /rust handler exploded/.test(err.message),
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
  const engine = createRkyvV2Engine(native, new Map());
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
  const engine = createRkyvV2Engine(native, new Map());
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
  const engine = createRkyvV2Engine(native, new Map());

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
  const engine = createRkyvV2Engine(native, new Map());
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
  const engine = createRkyvV2Engine(native, new Map());

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
  const engine = createRkyvV2Engine(native, new Map());
  const out = await engine.invokeBatch<Array<{ echo: string }>>([
    { command: 'a', args: {} },
    { command: 'b', args: {} },
  ]);
  assert.deepEqual(out, [{ echo: 'a' }, { echo: 'b' }]);
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
      const u = new Uint8Array(frame);
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

test('tier3 dynamic command falls back to shallow cancel even with invokeAsync exposed (T1)', async () => {
  // tier 게이팅(동적 경로): 레지스트리 코덱이 없는 tier 3 명령도 전파 제외.
  let cancels = 0;
  let asyncCalls = 0;
  const native = makeNative({
    schema: schemaBytes([{ name: 'dyn', commandId: 3 }]),
    invokeImpl: () => tier3Success({ v: 1 }),
  });
  native.invokeAsync = () => {
    asyncCalls++;
    return 1;
  };
  native.invokeCancel = () => {
    cancels++;
    return true;
  };
  const engine = createRkyvV2Engine(native, new Map());
  const ac = new AbortController();
  const p = engine.invoke<{ v: number }>('dyn', {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RustraCommandError && e.code === 'cancelled');
    return true;
  });
  assert.equal(asyncCalls, 0, 'invokeAsync must not be used for tier3 dynamic commands');
  assert.equal(cancels, 0, 'invokeCancel must not be called on shallow fallback');
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
  const engine = createRkyvV2Engine(native, new Map(), { maxPayloadBytes: 8 });
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
