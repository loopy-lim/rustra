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
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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

// ── 핫스왑 reload (Task A1) ──────────────────────────────────────────────────
//
// 실측(2026-08-31, macOS arm64 + Bun 1.4.0): bun:ffi dlopen 은 파일이 같은
// 경로에서 교체되어도 프로세스가 닫지 않은 핸들을 하나라도 연 적 있으면 예전
// 이미지를 돌려준다(v1 로드 → v2 로 교체 → 재 dlopen → 여전히 v1).
// close-후-재 dlopen 은 새 바이트를 얻지만, rustra 엔진은 어댑터 외부에서도
// 핸들이 살아 있을 수 있어 진짜 이미지 스왑은 보장할 수 없다. 따라서 A1 계약은
// "엔진 상태 재초기화 + 새 바이너리는 다음 프로세스 시작 시 적용" 경고.

test('createBunBootstrap reload re-initializes engine state and warns loudly', async () => {
  const bootstrap = createBunBootstrap({
    libraryCandidates: [
      resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`),
      resolve(repoRoot, `target/debug/librustra_calculator_example.${suffix}`),
    ],
    rkyvV2Codecs: testRegistry,
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  try {
    const first = await bootstrap.ready();
    const one = await first.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(one.value, 42);

    await bootstrap.reload();

    assert.ok(
      warnings.some((line) => line.includes('[bun] engine re-initialized')),
      'reload must warn that the rebuilt cdylib applies on next process start',
    );
    assert.ok(
      warnings.some((line) => line.includes('bun:ffi caches the library image')),
      'warning must state the dlopen caching finding',
    );
    const second = await bootstrap.ready();
    assert.notEqual(second, first, 'reload must produce a fresh engine instance');
    const two = await second.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(two.value, 42, 're-initialized engine serves commands');
  } finally {
    console.warn = originalWarn;
    bootstrap.dispose();
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

test('createBunFfiEngine decodes caller-buffer responses without a copy', async () => {
  const runtime = await createBunFfiEngine({
    libraryCandidates: [resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`)],
    rkyvV2Codecs: testRegistry,
  });
  try {
    const engine = runtime.engine;
    // 작은 응답은 재사용 caller 버퍼의 backing ArrayBuffer 를 그대로 돌려받는다
    // (slice 복사 없음 — 트랙 C3). 프레임은 오프셋 0이고 길이는 프레임 내부
    // 구조(varint/len 접두어)가 전달하므로 byteLength 가 capacity 여도 디코드는
    // 정확하다. 버퍼는 이 호출의 동기 디코드 동안만 유효하다(다음 invoke 가
    // 덮어씀).
    const small = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(small.value, 42);
    // 이어지는 호출들이 같은 재사용 버퍼를 덮어써도 결과 오염이 없어야 한다.
    for (let i = 0; i < 3; i += 1) {
      const again = await engine.invoke<{ value: number }>('addNumbers', { a: i, b: 42 });
      assert.equal(again.value, 42 + i);
    }
  } finally {
    runtime.close();
  }
});

// ── A02: EngineSupports 표면 — 매트릭스 셀의 기계 판독 가능한 이행 ─────────
// 매핑: signal(진행 중 취소) ⚠️ 얕은 취소 → 'shallow' / invokeBatch ✅ per-entry
// Promise fallback → 'per-entry' / 이벤트 ✅ FFI 푸시 싱크(폴링 폴백) → 'push'
// / 채널 ❌ → false / timeoutMs ✅ 레이스 → true.

test('A02: createBunEngine exposes supports matching the compatibility matrix', async () => {
  const engine = createBunEngine({
    invoke: () => ({ value: 1 }),
  });
  assert.deepEqual(engine.supports, {
    cancellation: 'shallow',
    batch: 'per-entry',
    events: 'push',
    channels: false,
    timeoutPreemption: true,
  });
});

// ── A05: bootstrap 수명 상태 모델 — 'initializing' | 'ready' | 'disposed' ──
// dispose 는 멱등(두 번째는 no-op)하되 dispose 후 ready 는 loud-fail 한다.
// 각 테스트는 글로벌 슬롯을 configure 로 리셋한 뒤 등록한다(R08 가드 — 소비 전
// 경쟁 등록 loud-fail 은 여기서 재검증 대상이 아니다).

const A05_SLOT_ENGINE = {
  invoke: async <T>() => 'slot' as T,
} as unknown as import('@rustra/types').EngineClientWithBatch;

test('A05: createBunBootstrap exposes the lifecycle state surface', async () => {
  const { configure } = await import('@rustra/types');
  configure(A05_SLOT_ENGINE);
  try {
    const bootstrap = createBunBootstrap({ libraryCandidates: [], rkyvV2Codecs: testRegistry });
    assert.equal(bootstrap.state, 'initializing');
    await assert.rejects(bootstrap.ready(), /RUSTRA_BUN_LIBRARY|No compatible/);
    assert.equal(bootstrap.state, 'initializing');
    bootstrap.dispose();
    assert.equal(bootstrap.state, 'disposed');
  } finally {
    configure(A05_SLOT_ENGINE);
  }
});

test('A05: ready after dispose rejects loudly (bun)', async () => {
  const { configure } = await import('@rustra/types');
  configure(A05_SLOT_ENGINE);
  try {
    const bootstrap = createBunBootstrap({ libraryCandidates: [], rkyvV2Codecs: testRegistry });
    bootstrap.dispose();
    await assert.rejects(bootstrap.ready(), (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.match((err as RustraCommandError).message, /disposed/);
      return true;
    });
  } finally {
    configure(A05_SLOT_ENGINE);
  }
});

test('A05: dispose is idempotent — second dispose is a no-op (bun)', async () => {
  const { configure } = await import('@rustra/types');
  configure(A05_SLOT_ENGINE);
  try {
    const bootstrap = createBunBootstrap({ libraryCandidates: [], rkyvV2Codecs: testRegistry });
    bootstrap.dispose();
    bootstrap.dispose(); // no-op — must not throw
    assert.equal(bootstrap.state, 'disposed');
  } finally {
    configure(A05_SLOT_ENGINE);
  }
});

test('A05: concurrent ready calls share one initialization promise (bun)', async () => {
  const { configure } = await import('@rustra/types');
  configure(A05_SLOT_ENGINE);
  const bootstrap = createBunBootstrap({ libraryCandidates: [], rkyvV2Codecs: testRegistry });
  // dlopen 실패라도 두 ready 는 같은 초기화 프라미스를 공유한다 — 실패가 1회
  // 기록되고 두 프라미스가 같은 rejection 으로 정착하면 계약 충족.
  const [a, b] = await Promise.allSettled([bootstrap.ready(), bootstrap.ready()]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  assert.equal(
    (a as PromiseRejectedResult).reason,
    (b as PromiseRejectedResult).reason,
    'both ready calls must observe the same failure',
  );
  bootstrap.dispose();
  configure(A05_SLOT_ENGINE);
});

test('A02: createBunFfiEngine exposes supports reflecting the actual FFI bindings (real dylib)', async () => {
  // 리뷰 정정 — bun FFI native 는 invokeRkyvV2/getSchema/getContractHash/
  // getSchemaGeneration 만 바인딩한다. invokeAsync/invokeCancel·invokeTypedBatch
  // 심볼은 바인딩되지 않으므로 rkyv V2 코어의 전파/단일 횡단 조건이 도달 불가:
  // 취소는 얕은 취소, 배치는 항목별 폴백으로 관측된다.
  const runtime = await createBunFfiEngine({
    libraryCandidates: [resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`)],
    rkyvV2Codecs: testRegistry,
  });
  try {
    assert.deepEqual(runtime.engine.supports, {
      cancellation: 'shallow',
      batch: 'per-entry',
      events: 'push',
      channels: false,
      timeoutPreemption: true,
    });
  } finally {
    runtime.close();
  }
});
