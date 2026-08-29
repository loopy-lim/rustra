import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap, createBunEngine, createBunFfiEngine } from './index.js';
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
// benchEchoBytes(cmd_id=25)의 wire 수동 인코더/디코더 — [cmd_id u16 LE]
// [postcard: varint(len)+bytes]. 응답은 [ok u8][pad3][len u32 LE @4]
// [postcard body @8]. 512B 초과 응답으로 caller-buffer overflow 재시도 경로를
// 검증한다(Rust 핸들러는 bench_echo_bytes = echo).
const benchEchoBytesCodec = (): RkyvV2Codec<Uint8Array, Uint8Array> => ({
  commandId: 25,
  encode(args) {
    const out = new Uint8Array(2 + 5 + args.length);
    out[0] = 25;
    out[1] = 0;
    let v = args.length;
    let w = 2;
    while (v > 0) {
      out[w++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    out[w - 1] &= 0x7f;
    out.set(args, w);
    return out.slice(0, w + args.length).buffer;
  },
  decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 1) return { ok: false, error: { code: 'invoke.failed', message: 'failed' } };
    let v = 0;
    let shift = 0;
    let i = 8;
    for (;;) {
      const b = bytes[i++]!;
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return { ok: true, result: bytes.slice(i, i + v) };
  },
});
const benchEchoBytes = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

const testRegistry = new Map<string, RkyvV2Codec<unknown, unknown>>([
  ['addNumbers', addNumbersCodec as RkyvV2Codec<unknown, unknown>],
  ['benchEchoBytes', benchEchoBytesCodec() as RkyvV2Codec<unknown, unknown>],
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

test('createBunEngine applies timeoutMs and shallow abort to pending transports', async () => {
  const engine = createBunEngine({
    invoke: () => new Promise<never>(() => {}),
  });

  await assert.rejects(
    engine.invoke('slow', undefined, { timeoutMs: 10 }),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'transport.timeout',
  );

  const controller = new AbortController();
  const pending = engine.invoke('cancel-me', undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof RustraCommandError && err.code === 'cancelled',
  );
});

test('createBunEngine exposes Promise-based invokeBatch with stable order', async () => {
  const engine = createBunEngine({
    async invoke(command) {
      return command === 'first' ? 1 : 2;
    },
  });
  const out = await engine.invokeBatch<number>([{ command: 'first' }, { command: 'second' }]);
  assert.deepEqual(out, [1, 2]);
});

test('createBunEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createBunEngine({
    async invoke() {
      throw { code: 'transport.timeout', message: 'request timed out', retryable: true };
    },
  });

  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal(err.code, 'transport.timeout');
      assert.equal(err.message, 'request timed out');
      assert.equal(err.retryable, true);
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

// ── rkyv V2 caller-buffer (`_into`) 바인딩 ──────────────────────────────────
//
// C++ typedInvokeTail(RustraJSIBridge.cpp)과 동일한 계약: 512B 재사용 버퍼로
// 바로 dispatch+write, 부족하면 usize::MAX 상태 + 필요 크기 → 정확한 크기로
// 1회 재시도. Rust 는 응답을 malloc 하지 않으므로 free 짝이 필요 없다.

test('rustra_ffi_invoke_rkyv_v2_into honors the caller-buffer status contract', async () => {
  const { dlopen, FFIType, suffix } = await import('bun:ffi');
  const dylib = resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`);
  const lib = dlopen(dylib, {
    rustra_ffi_invoke_rkyv_v2_into: {
      args: [FFIType.ptr, 'usize' as const, FFIType.ptr, 'usize' as const, FFIType.ptr],
      returns: 'usize' as const,
    },
  });
  const into = lib.symbols.rustra_ffi_invoke_rkyv_v2_into;
  // addNumbers(cmd_id=1) 프레임 — [1,0,zigzag(20),zigzag(22)], 응답 9B.
  const request = new Uint8Array([1, 0, 40, 44]);
  const outLength = new BigUint64Array(1);
  const buffer = new Uint8Array(512);

  // 바로 write: 상태는 기록 바이트 수(9), 응답은 버퍼에 직접 기록된다.
  // malloc 처럼 소유 포인터를 돌려주지 않는다 — free 짝이 없다.
  const written = into(request, BigInt(request.byteLength), buffer, 512, outLength);
  assert.equal(typeof written, 'bigint');
  assert.equal(written, 9n);
  assert.equal(outLength[0], 9n);
  assert.equal(buffer[0], 1); // ok
  assert.equal(buffer[8], 84); // zigzag(42)

  // 부족한 버퍼: usize::MAX 상태 + out_len 에 필요 크기. 같은 응답이 코어
  // probe 캐시에 유지되어 정확한 크기 재시도가 핸들러를 재실행하지 않는다.
  const overflow = into(request, BigInt(request.byteLength), buffer, 4, outLength);
  assert.equal(overflow, 0xffff_ffff_ffff_ffffn);
  assert.equal(outLength[0], 9n);
  const retried = into(
    request,
    BigInt(request.byteLength),
    buffer,
    Number(outLength[0]),
    outLength,
  );
  assert.equal(retried, 9n);
  assert.equal(buffer[8], 84);
});

test('createBunFfiEngine dispatches rkyv V2 through the caller-buffer into binding', async () => {
  const runtime = await createBunFfiEngine({
    libraryCandidates: [resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`)],
    rkyvV2Codecs: testRegistry,
  });
  try {
    // 어댑터가 malloc 변형이 아닌 _into 바인딩을 사용해야 한다.
    assert.equal(runtime.usesCallerBufferInto, true);
    const engine = runtime.engine;

    // 1) 작은 응답 — 재사용 512B 버퍼 경로.
    const small = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(small.value, 42);

    // 2) 큰 응답(610B > 512B) — overflow 상태 → 정확한 크기 heap 재시도.
    const payload = benchEchoBytes(600);
    const big = await engine.invoke<Uint8Array>('benchEchoBytes', payload);
    assert.deepEqual(big, payload);

    // 3) buffer 재사용 계약 — 이전 호출의 소유 결과는 이후 호출이 같은 재사용
    // 버퍼를 덮어써도 오염되지 않는다(malloc'd 포인터/뷰 공유 없음).
    const kept = await engine.invoke<Uint8Array>('benchEchoBytes', benchEchoBytes(600));
    await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(kept.length, 600);
    assert.deepEqual(kept, benchEchoBytes(600));
  } finally {
    runtime.close();
  }
});
