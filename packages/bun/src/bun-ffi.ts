import {
  configureLazy,
  createRkyvV2Engine,
  ensureConfigured,
  RustraErrorCode,
  RustraCommandError,
  type EngineSupports,
  type RkyvV2Engine,
} from '@rustra/types';
import type { Pointer } from 'bun:ffi';
import {
  bunLibraryCandidates,
  type BunFfiEngineOptions,
  type BunFfiRuntime,
} from './bun-ffi-library.js';
import { disposedBootstrapError } from './bootstrap-lifecycle.js';

/**
 * Bun JSON 엔진의 기술적 지표(A02) — compatibility-matrix.md 의 Bun 열 셀을
 * 그대로 옮긴 것: in-flight 취소는 얕은 취소, 배치는 per-entry 폴백, 이벤트는
 * FFI 푸시 싱크(폴링 폴백), 채널 소스 없음, timeoutMs 레이스 있음.
 */
export const BUN_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'shallow',
  batch: 'per-entry',
  events: 'push',
  channels: false,
  timeoutPreemption: true,
};

/**
 * Bun FFI rkyv V2 엔진의 기술적 지표(A02) — 동일 createRkyvV2Engine 코어라도
 * Bun FFI 네이티브 바인딩은 invokeRkyvV2/getSchema/getContractHash/
 * getSchemaGeneration 뿐이다(invokeAsync/invokeCancel·invokeTypedBatch 심볼
 * 미바인딩). 따라서 rkyv 코어의 조건부 취소 전파와 정적 명령 단일 횡단 조건이
 * 도달 불가 — 관측값은 얕은 취소(`shallow`)와 항목별 폴백(`per-entry`)이다.
 * 이벤트는 FFI 푸시 싱크(폴링 폴백). 채널은 Bun FFI 네이티브에 소스가 없으므로
 * RN JSI 열과 달리 false 다.
 */
export const BUN_RKYV_V2_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'shallow',
  batch: 'per-entry',
  events: 'push',
  channels: false,
  timeoutPreemption: true,
};

export async function createBunFfiEngine(options: BunFfiEngineOptions): Promise<BunFfiRuntime> {
  const { dlopen, FFIType, toArrayBuffer } = await import('bun:ffi');
  const definitions = {
    rustra_mobile_init: { args: [], returns: FFIType.void },
    rustra_ffi_invoke_rkyv_v2: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    rustra_ffi_invoke_rkyv_v2_into: {
      args: [FFIType.ptr, 'usize' as const, FFIType.ptr, 'usize' as const, FFIType.ptr],
      returns: 'usize' as const,
    },
    rustra_ffi_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    rustra_ffi_get_schema: { args: [FFIType.ptr], returns: FFIType.ptr },
    rustra_ffi_contract_hash: { args: [FFIType.ptr], returns: FFIType.ptr },
    // (T0-3) 스키마 세대 — u64 반환, 인자 없음.
    rustra_ffi_schema_generation: { args: [], returns: 'u64' as const },
  } as const;
  const open = (library: string) => dlopen(library, definitions);
  let handle: ReturnType<typeof open> | undefined;
  let library = '';
  const failures: string[] = [];
  for (const candidate of bunLibraryCandidates(options)) {
    try {
      const loaded = open(candidate);
      loaded.symbols.rustra_mobile_init();
      handle = loaded;
      library = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!handle) {
    const detail = failures.length > 0 ? ` Tried ${failures.join('; ')}` : '';
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      `No compatible Rustra Bun cdylib was found. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.${detail}`,
    );
  }
  const outLength = new BigUint64Array(1);
  const copyOwned = (pointer: Pointer | bigint | null): ArrayBuffer => {
    if (pointer === null || Number(pointer) === 0) {
      throw new RustraCommandError('invoke.failed', 'Bun FFI returned a null response pointer');
    }
    const length = Number(outLength[0]);
    try {
      const borrowed = toArrayBuffer(pointer, 0, length);
      const owned = new ArrayBuffer(length);
      new Uint8Array(owned).set(new Uint8Array(borrowed));
      return owned;
    } finally {
      handle.symbols.rustra_ffi_free(pointer, BigInt(length));
    }
  };
  const callerBufferCapacity = 512;
  const callerBuffer = new Uint8Array(callerBufferCapacity);
  const statusOverflow = 0xffff_ffff_ffff_ffffn;
  const invokeRkyvV2Into = (payload: ArrayBuffer): ArrayBuffer | ArrayBufferView => {
    const request = new Uint8Array(payload);
    outLength[0] = 0n;
    const status = handle.symbols.rustra_ffi_invoke_rkyv_v2_into(
      request,
      BigInt(request.byteLength),
      callerBuffer,
      callerBufferCapacity,
      outLength,
    );
    if (status === statusOverflow) {
      const needed = Number(outLength[0]);
      if (needed <= callerBufferCapacity || needed === 0) {
        throw new RustraCommandError(
          'invoke.failed',
          `Bun FFI caller-buffer overflow reported an invalid size: ${needed}`,
        );
      }
      const large = new Uint8Array(needed);
      outLength[0] = 0n;
      const retried = handle.symbols.rustra_ffi_invoke_rkyv_v2_into(
        request,
        BigInt(request.byteLength),
        large,
        needed,
        outLength,
      );
      if (retried === 0n || retried === statusOverflow) {
        throw new RustraCommandError(
          'invoke.failed',
          `Bun FFI caller-buffer retry failed (status ${retried})`,
        );
      }
      if (retried === BigInt(needed)) return large.buffer;
      return large.subarray(0, Number(retried));
    }
    if (status === 0n) return new ArrayBuffer(0);
    if (status > callerBufferCapacity) {
      throw new RustraCommandError(
        'invoke.failed',
        `Bun FFI caller-buffer status exceeds capacity: ${status}`,
      );
    }
    // 재사용 caller 버퍼의 zero-copy 공유 — 응답 복사 1회 제거(트랙 C3). 프레임은
    // 오프셋 0부터 기록되므로 backing ArrayBuffer 를 그대로 돌려준다(뷰가 아니라
    // ArrayBuffer 인 이유: 생성된 코덱이 `new DataView(buf)` 로 ArrayBuffer 를
    // 요구한다 — packages/cli 금지 목록상 제너레이터는 못 고친다). byteLength 는
    // capacity(512)이고 프레임 길이는 프레임 내부 구조(postcard varint/tier3 len
    // 접두어)가 전달한다 — 완결 프레임에서 디코드는 프레임 내부에서 종료된다.
    // 공유 버퍼는 이 호출의 동기 디코드가 끝날 때까지만 유효하고, 다음 invoke 가
    // 같은 버퍼를 덮어쓴다(dispatch 계약 — 응답은 즉시 디코드됨).
    return callerBuffer.buffer;
  };
  const native = {
    invokeRkyvV2: (payload: ArrayBuffer) => invokeRkyvV2Into(payload),
    getSchema: () => {
      outLength[0] = 0n;
      return copyOwned(handle.symbols.rustra_ffi_get_schema(outLength));
    },
    getContractHash: () => {
      outLength[0] = 0n;
      return copyOwned(handle.symbols.rustra_ffi_contract_hash(outLength));
    },
    // (T0-3) 치환 재동기화 게이트용 세대 폴링 — u64 → JS number (안전 범위).
    getSchemaGeneration: () => Number(handle.symbols.rustra_ffi_schema_generation()),
  };
  const {
    rkyvV2Codecs,
    library: _library,
    libraryCandidates: _candidates,
    libraryName: _libraryName,
    ...engineOptions
  } = options;
  void _library;
  void _candidates;
  void _libraryName;
  const engine = createRkyvV2Engine(native, rkyvV2Codecs, engineOptions);
  // A02 — Bun FFI rkyv V2 엔진의 지표. FFI 바인딩에 invokeAsync/invokeCancel·
  // invokeTypedBatch 심볼이 없어 코어의 전파/단일 횡단 조건은 도달 불가 —
  // 관측값은 shallow 취소 + per-entry 배치(상수 주석 참고).
  engine.supports = { ...BUN_RKYV_V2_ENGINE_SUPPORTS };
  return {
    engine,
    library,
    usesCallerBufferInto: true,
    close: () => handle.close(),
  };
}

export type BunBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 'initializing' | 'ready' | 'disposed'.
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: 'initializing' | 'ready' | 'disposed';
  ready(): Promise<RkyvV2Engine>;
  dispose(): void;
  /**
   * Dev-loop reload hook target (Task A1). Empirically (macOS, Bun 1.4.0),
   * `bun:ffi` dlopen caches the library image per process: re-dlopen of a
   * REPLACED file at the same path returns the OLD bytes while any handle of
   * that image has ever been opened in the process — only close-then-reopen
   * picks up new bytes, and even then only when no other handle is alive.
   * Consequence: reload() re-runs engine init (fresh state over the resolved
   * library) and WARNS that a rebuilt binary applies on the next process start
   * unless every previous handle was closed first. Contract is the warning +
   * state reset, not a true image swap — see docs/compatibility-matrix.md.
   */
  reload(): Promise<void>;
};

export function createBunBootstrap(options: BunFfiEngineOptions): BunBootstrap {
  let runtime: BunFfiRuntime | undefined;
  let state: 'initializing' | 'ready' | 'disposed' = 'initializing';
  const bootstrap = async (): Promise<RkyvV2Engine> => {
    runtime = await createBunFfiEngine(options);
    return runtime.engine;
  };
  configureLazy(bootstrap);
  const dispose = () => {
    if (state === 'disposed') return; // dispose-once 멱등 — 두 번째는 no-op
    state = 'disposed';
    runtime?.close();
    runtime = undefined;
  };
  return {
    get state() {
      return state;
    },
    ready: () => {
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Bun'));
      return (ensureConfigured() as Promise<RkyvV2Engine>).then((engine) => {
        if (state === 'disposed') throw disposedBootstrapError('Bun');
        state = 'ready';
        return engine;
      });
    },
    dispose,
    async reload() {
      // 엔진 상태 재초기화 — a0 스파이크가 증명한 프로세스 내 리셋 경로.
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Bun'));
      dispose();
      configureLazy(bootstrap);
      await (ensureConfigured() as Promise<RkyvV2Engine>);
      state = 'ready';
      // 경고는 재초기화가 실제 성공한 뒤에 — 실패 시 false success 신호 방지.
      console.warn(
        '[bun] engine re-initialized. bun:ffi caches the library image: a rebuilt ' +
          'cdylib applies on the next process start (reload cannot swap bytes in-process).',
      );
    },
  };
}
