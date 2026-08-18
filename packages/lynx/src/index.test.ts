// @rustra/lynx 어댑터 단위 테스트.
// 어댑터 고유 로직(createFastEngine 위임, getRustraNative 글로벌 접근,
// createLynxEngine JSON 폴백)만 검증 — rkyv V2 엔진 자체는 @rustra/types에서 검증됨.
// 저장소 표준(node:test + node:assert/strict, ESM) 사용.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFastEngine,
  createLynxEngine,
  getRustraNative,
  RustraCommandError,
} from './index.js';
import type { RkyvV2Codec, RkyvV2SchemaNative } from '@rustra/types';

// ── createFastEngine: rkyv V2 fast-path 위임 ────────────────

test('createFastEngine routes invoke through codec → native.invokeRkyvV2 → codec', async () => {
  let encodedPayload: ArrayBuffer | null = null;
  const native: RkyvV2SchemaNative = {
    invokeRkyvV2: (payload) => {
      encodedPayload = payload;
      return new ArrayBuffer(8); // 내용은 codec.decode 가 결정
    },
  };

  const codec: RkyvV2Codec<{ a: number }, { value: number }> = {
    commandId: 1,
    encode: (args) => {
      const ab = new ArrayBuffer(1);
      new Uint8Array(ab)[0] = args.a & 0xff;
      return ab;
    },
    decode: () => ({ ok: true, result: { value: 42 } }),
  };
  const registry = new Map<string, RkyvV2Codec<unknown, unknown>>([['add', codec]]);

  const engine = createFastEngine(native, { rkyvV2Codecs: registry });
  const out = await engine.invoke<{ value: number }>('add', { a: 1 });

  assert.equal(out.value, 42);
  assert.ok(encodedPayload, 'native.invokeRkyvV2 must be called');
  assert.equal(new Uint8Array(encodedPayload!)[0], 1, 'codec.encode output is passed to native');
});

test('createFastEngine throws RustraCommandError when codec decodes an error response', async () => {
  const native: RkyvV2SchemaNative = {
    invokeRkyvV2: () => new ArrayBuffer(0),
  };
  const codec: RkyvV2Codec<unknown, unknown> = {
    commandId: 1,
    encode: () => new ArrayBuffer(0),
    decode: () => ({
      ok: false,
      error: { code: 'native.exploded', message: 'native exploded' },
    }),
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map([['boom', codec]]),
  });

  await assert.rejects(
    async () => {
      await engine.invoke('boom', {});
    },
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError, 'must be RustraCommandError');
      assert.equal((err as RustraCommandError).code, 'native.exploded');
      assert.match((err as Error).message, /native exploded/);
      return true;
    },
  );
});

// ── createLynxEngine: JSON 폴백 ─────────────────────────────

function jsonNative(returnValue: unknown): { invoke(payload: ArrayBuffer): ArrayBuffer } {
  const encoder = new TextEncoder();
  return {
    invoke: () => encoder.encode(JSON.stringify(returnValue)).buffer as ArrayBuffer,
  };
}

test('createLynxEngine decodes a JSON success response', async () => {
  const engine = createLynxEngine(jsonNative({ ok: true, result: { value: 42 } }));
  const out = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(out, { value: 42 });
});

test('createLynxEngine throws on error response with default message', async () => {
  const engine = createLynxEngine(jsonNative({ ok: false, error: 'command not found' }));
  await assert.rejects(
    async () => {
      await engine.invoke('missing');
    },
    (err: Error) => {
      assert.ok(err instanceof RustraCommandError, 'F4: must be RustraCommandError');
      assert.equal(err.message, 'command not found');
      return true;
    },
  );
});

test('createLynxEngine includes default error message when error missing', async () => {
  const engine = createLynxEngine(jsonNative({ ok: false }));
  await assert.rejects(
    async () => {
      await engine.invoke('cmd');
    },
    (err: Error) => {
      assert.equal(err.message, 'Rustra invoke failed');
      return true;
    },
  );
});

// ── getRustraNative: 글로벌 NativeModules 접근 ──────────────

function setNativeModules(value: unknown) {
  (globalThis as Record<string, unknown>).NativeModules = value;
}

test.afterEach(() => {
  delete (globalThis as Record<string, unknown>).NativeModules;
});

test('getRustraNative reads NativeModules.RustraModule from the Lynx global', () => {
  const mock: RkyvV2SchemaNative = {
    invokeRkyvV2: () => new ArrayBuffer(0),
  };
  setNativeModules({ RustraModule: mock });

  assert.equal(getRustraNative(), mock);
});

test('getRustraNative throws when NativeModules is undefined', () => {
  setNativeModules(undefined);
  assert.throws(
    () => getRustraNative(),
    (err: Error) => /NativeModules\.RustraModule not registered/.test(err.message),
  );
});

test('getRustraNative throws when RustraModule is missing', () => {
  setNativeModules({ OtherModule: {} });
  assert.throws(
    () => getRustraNative(),
    (err: Error) => /NativeModules\.RustraModule not registered/.test(err.message),
  );
});

// ── Trust-test baseline (Phase 0) ───────────────────────────

test('F3: createLynxEngine native throw is caught by .catch() (Promise<T> honored)', async () => {
  // EngineClient 계약상 invoke() 실패는 rejected Promise 여야 한다.
  // async 전환 후 동기 throw 는 rejected Promise 로 정규화되어 .catch() 에서 잡힌다.
  const engine = createLynxEngine({
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

// ── FastEngineOptions → core 옵션 전달 (follow-up 2) ───────
// 어댑터는 "전달됐는지"만 검증 — core 동작 상세는 @rustra/types 에서 이미 검증됨.

const optionsEncoder = new TextEncoder();

test('createFastEngine forwards maxPayloadBytes to the core pre-check', async () => {
  // maxPayloadBytes: 8 → 인코딩 후 8B 초과면 payload.too_large 로 네이티브 호출 없이 reject.
  const native: RkyvV2SchemaNative = {
    invokeRkyvV2: () => {
      throw new Error('native must not be called for an over-limit payload');
    },
  };
  const codec: RkyvV2Codec<unknown, unknown> = {
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
  const native: RkyvV2SchemaNative = {
    invokeRkyvV2: () => new ArrayBuffer(8),
    getSchema: () =>
      optionsEncoder.encode(JSON.stringify({ schemaVersion: 1, commands: [] }))
        .buffer as ArrayBuffer,
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map(),
    schemaVersion: 4,
    onSchemaStale: (info) => stale.push(info),
  });
  assert.ok(engine, 'engine is created');
  assert.deepEqual(stale, [{ nativeVersion: 1, jsVersion: 4 }]);
});

test('createFastEngine forwards onContractMismatch (degraded mode entry)', () => {
  const mismatches: unknown[] = [];
  const native: RkyvV2SchemaNative = {
    invokeRkyvV2: () => new ArrayBuffer(0),
    getContractHash: () => optionsEncoder.encode('native-hash-AAAA').buffer as ArrayBuffer,
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
