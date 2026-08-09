// createRkyvV2Engine Tier 3 fallback + getLiveSchema 단위 테스트.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRkyvV2Engine,
  getLiveSchema,
} from './index.js';
import type { RkyvV2SchemaNative, RkyvV2Codec } from './index.js';

// ── wire 헬퍼 (TS 측 Tier 3 wire) ───────────────────────────
// request:  [command_id: u16 LE @0][json @2]
// success:  [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
// error:    [ok:0 @0][pad to @8][err_len: u16 LE @8][err @10]

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

function tier3Success(value: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const ab = new ArrayBuffer(8 + json.length);
  const view = new Uint8Array(ab);
  view[0] = 1; // ok
  new DataView(ab).setUint32(4, json.length, true);
  view.set(json, 8);
  return ab;
}

function tier3Error(msg: string): ArrayBuffer {
  const err = new TextEncoder().encode(msg);
  const ab = new ArrayBuffer(10 + err.length);
  const view = new Uint8Array(ab);
  view[0] = 0; // error
  new DataView(ab).setUint16(8, err.length, true);
  view.set(err, 10);
  return ab;
}

function schemaBytes(
  commands: Array<{ name: string; commandId: number }>,
): ArrayBuffer {
  return bytesFromStrings([
    JSON.stringify({ packageId: 't', commands }),
  ]);
}

interface NativeOpts {
  schema?: ArrayBuffer;
  invokeImpl?: (payload: ArrayBuffer) => ArrayBuffer;
}

function makeNative(opts: NativeOpts): RkyvV2SchemaNative {
  return {
    getSchema: () => opts.schema ?? schemaBytes([]),
    invokeRkyvV2: (payload) =>
      opts.invokeImpl ? opts.invokeImpl(payload) : new ArrayBuffer(0),
  };
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
  const n = await engine.invoke<{ outer: { inner: { v: number }; tags: string[] } }>(
    'nested',
    {},
  );
  assert.equal(n.outer.inner.v, 99);
  assert.deepEqual(n.outer.tags, ['a', 'b']);
});

test('engine Tier 3 fallback propagates error wire', async () => {
  const native = makeNative({
    schema: schemaBytes([{ name: 'boom', commandId: 1 }]),
    invokeImpl: () => tier3Error('handler exploded'),
  });
  const engine = createRkyvV2Engine(native, new Map());
  // invoke 가 에러 시 동기 throw 하므로 async 래퍼로 rejection 처리.
  await assert.rejects(
    async () => {
      await engine.invoke('boom', {});
    },
    (err: Error) => /handler exploded/.test(err.message),
  );
});

test('engine throws for command absent from registry AND live schema', async () => {
  const native = makeNative({
    schema: schemaBytes([{ name: 'known', commandId: 1 }]),
    invokeImpl: () => tier3Success({}),
  });
  const engine = createRkyvV2Engine(native, new Map());
  await assert.rejects(
    async () => {
      await engine.invoke('unknown', {});
    },
    (err: Error) => /no codec and not in live schema/.test(err.message),
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
