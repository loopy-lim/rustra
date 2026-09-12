import {
  configureLazy,
  createFrameEngine,
  disposedBootstrapError,
  ensureConfigured,
  RustraErrorCode,
  RustraCommandError,
  type BootstrapState,
  type EngineSupports,
  type FrameEngine,
} from '@rustra/types';
import type { Pointer } from 'bun:ffi';
import {
  bunLibraryCandidates,
  selectVerifiedLibrary,
  type BunFfiEngineOptions,
  type BunFfiRuntime,
} from './bun-ffi-library.js';

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
 * Bun FFI Frame 엔진의 기술적 지표(A02) — 동일 createFrameEngine 코어라도
 * Bun FFI 네이티브 바인딩은 invokeFrame/getSchema/getContractHash/
 * getSchemaGeneration 뿐이다(invokeAsync/invokeCancel·invokeTypedBatch 심볼
 * 미바인딩). 따라서 frame 코어의 조건부 취소 전파와 정적 명령 단일 횡단 조건이
 * 도달 불가 — 관측값은 얕은 취소(`shallow`)와 항목별 폴백(`per-entry`)이다.
 * 이벤트는 FFI 푸시 싱크(폴링 폴백). 채널은 Bun FFI 네이티브에 소스가 없으므로
 * RN JSI 열과 달리 false 다.
 */
export const BUN_FRAME_ENGINE_SUPPORTS: EngineSupports = {
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
    rustra_ffi_invoke_frame: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    rustra_ffi_invoke_frame_into: {
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
  const {
    frameCodecs,
    library: _library,
    libraryCandidates: _candidates,
    libraryName: _libraryName,
    ...engineOptions
  } = options;
  void _library;
  void _candidates;
  void _libraryName;
  /** 후보별 런타임 조립 — 계약 기각된 후보의 바인딩·버퍼는 핸들과 함께 폐기된다.
   * dlopen 성공만으로 후보를 확정하지 않고 엔진 생성의 계약 handshake 까지
   * 검증한다(감사 A1). */
  const buildRuntime = (handle: ReturnType<typeof open>, library: string): BunFfiRuntime => {
    let closed = false;
    const assertOpen = () => {
      if (closed) throw disposedBootstrapError('Bun FFI');
    };
    const close = () => {
      if (closed) return;
      closed = true;
      handle.close();
    };
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
    const invokeFrameInto = (payload: ArrayBuffer): ArrayBuffer | ArrayBufferView => {
      assertOpen();
      const request = new Uint8Array(payload);
      outLength[0] = 0n;
      const status = handle.symbols.rustra_ffi_invoke_frame_into(
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
        const retried = handle.symbols.rustra_ffi_invoke_frame_into(
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
      invokeFrame: invokeFrameInto,
      getSchema: () => {
        assertOpen();
        outLength[0] = 0n;
        return copyOwned(handle.symbols.rustra_ffi_get_schema(outLength));
      },
      getContractHash: () => {
        assertOpen();
        outLength[0] = 0n;
        return copyOwned(handle.symbols.rustra_ffi_contract_hash(outLength));
      },
      // (T0-3) 치환 재동기화 게이트용 세대 폴링 — u64 → JS number (안전 범위).
      getSchemaGeneration: () => {
        assertOpen();
        return Number(handle.symbols.rustra_ffi_schema_generation());
      },
    };
    const engine = createFrameEngine(native, frameCodecs, engineOptions);
    // A02 — Bun FFI Frame 엔진의 지표. FFI 바인딩에 invokeAsync/invokeCancel·
    // invokeTypedBatch 심볼이 없어 코어의 전파/단일 횡단 조건은 도달 불가 —
    // 관측값은 shallow 취소 + per-entry 배치(상수 주석 참고).
    engine.supports = { ...BUN_FRAME_ENGINE_SUPPORTS };
    // Guard method calls, including empty batches and cached sync entry points.
    // Native guards also protect already-resolved generated routes.
    for (const key of Reflect.ownKeys(engine)) {
      const method = Reflect.get(engine, key);
      if (typeof method !== 'function') continue;
      Reflect.set(engine, key, (...args: unknown[]) => {
        if (closed && (key === 'invoke' || key === 'invokeById' || key === 'invokeBatch'))
          return Promise.reject(disposedBootstrapError('Bun FFI'));
        assertOpen();
        return Reflect.apply(method, engine, args);
      });
    }
    return {
      engine,
      library,
      usesCallerBufferInto: true,
      close,
    };
  };
  // 후보 선택(감사 A1) — dlopen/init 실패는 probe 기각, 계약 mismatch 는 다음
  // 후보 폴백. stale release cdylib 이 먼저 발견돼도 방금 빌드한 후보로 넘어간다.
  const selection = await selectVerifiedLibrary(bunLibraryCandidates(options), (candidate) => {
    const loaded = open(candidate);
    try {
      loaded.symbols.rustra_mobile_init();
      return buildRuntime(loaded, candidate);
    } catch (error) {
      loaded.close();
      throw error;
    }
  });
  if (!('runtime' in selection)) {
    const detail =
      selection.probeFailures.length > 0 ? ` Tried ${selection.probeFailures.join('; ')}` : '';
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      `No compatible Rustra Bun cdylib was found. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.${detail}`,
    );
  }
  return selection.runtime;
}

export type BunBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 공용 `BootstrapState`(@rustra/types).
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: BootstrapState;
  ready(): Promise<FrameEngine>;
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
  let state: BootstrapState = 'initializing';
  let reloadPromise: Promise<void> | undefined;
  const assertActive = () => {
    if (state === 'disposed') throw disposedBootstrapError('Bun');
    if (!registration.isCurrent())
      throw new RustraCommandError(
        'transport.unavailable',
        'Bun bootstrap registration was replaced',
      );
  };
  const bootstrap = async (): Promise<FrameEngine> => {
    assertActive();
    const created = await createBunFfiEngine(options);
    try {
      assertActive();
      runtime = created;
      return created.engine;
    } catch (error) {
      created.close();
      throw error;
    }
  };
  let registration = configureLazy(bootstrap, { ownerId: 'bun' });
  const ready = async (): Promise<FrameEngine> => {
    assertActive();
    const requestedRegistration = registration;
    try {
      const engine = (await ensureConfigured()) as FrameEngine;
      assertActive();
      if (requestedRegistration !== registration)
        throw new RustraCommandError(
          'transport.unavailable',
          'Bun readiness was superseded by reload; call ready() again',
        );
      state = 'ready';
      return engine;
    } catch (error) {
      if (!registration.isCurrent()) {
        runtime?.close();
        runtime = undefined;
      }
      throw error;
    }
  };
  return {
    get state() {
      return state;
    },
    ready,
    dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      registration();
      runtime?.close();
      runtime = undefined;
    },
    reload() {
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Bun'));
      if (reloadPromise) return reloadPromise;
      const operation = async () => {
        assertActive();
        if (state !== 'ready') await ready();
        assertActive();
        state = 'initializing';
        runtime?.close();
        runtime = undefined;
        registration = configureLazy(bootstrap, { ownerId: 'bun' });
        await ready();
        console.warn(
          '[bun] engine re-initialized. bun:ffi caches the library image: a rebuilt ' +
            'cdylib applies on the next process start (reload cannot swap bytes in-process).',
        );
      };
      reloadPromise = operation().finally(() => {
        reloadPromise = undefined;
      });
      return reloadPromise;
    },
  };
}
