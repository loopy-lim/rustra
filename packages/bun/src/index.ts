/**
 * @rustra/bun — Bun용 rustra 엔진 어댑터
 *
 * `@rustra/types`의 글로벌 invoke + Bun FFI 전용 엔진을 제공합니다.
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/bun';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * configure(createRkyvV2Engine(ffiBridge, rkyvV2Registry));
 *
 * // 이후 어디서든
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

export type {
  EngineClient,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  RkyvV2EngineOptions,
  InvokeOptions,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  ensureConfigured,
  invoke,
  createRkyvV2Engine,
} from '@rustra/types';
import {
  configureLazy,
  createRkyvV2Engine,
  ensureConfigured,
  parseRustraErrorString,
  RustraErrorCode,
  RustraCommandError,
  type EngineClient,
  type InvokeOptions,
  type RkyvV2Codec,
  type RkyvV2EngineOptions,
} from '@rustra/types';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pointer } from 'bun:ffi';

/**
 * Bun transport가 구현해야 하는 인터페이스입니다.
 */
export type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

/**
 * Bun FFI 등 JSON transport로 EngineClient을 생성합니다.
 */
export function createBunEngine(transport: BunInvokeTransport) {
  return {
    async invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      // signal 정책(전 어댑터 공통): abort 된 signal 만 cancelled 로 거부하고,
      // 미abort signal 은 정상 실행한다(얕은 취소 — 실행 중 abort 는 결과를 무시할
      // 뿐). useCommand 처럼 항상 signal 을 전달하는 호출부와의 호환을 위해 signal
      // 존재 자체를 에러로 삼지 않는다 — 매트릭스(docs/compatibility-matrix.md) 참고.
      if (options?.signal?.aborted) {
        throw new RustraCommandError(
          'cancelled',
          `invoke("${command}") aborted before dispatch`,
          true,
        );
      }
      try {
        return (await transport.invoke(command, args)) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        // Rust 와이어 에러 — reason 이 RustraError JSON 또는 "code: message"
        // Display 문자열인 경우 parseRustraErrorString 이 code/retryable 을
        // 복원한다. @rustra/node 와 동일 파이프라인(unknown 래핑 방지).
        if (e instanceof Error) {
          throw parseRustraErrorString(e.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}

export type BunFfiEngineOptions = Omit<RkyvV2EngineOptions, 'rkyvV2Codecs'> & {
  rkyvV2Codecs: Map<string, RkyvV2Codec<unknown, unknown>>;
  /** Explicit cdylib. `RUSTRA_BUN_LIBRARY` has higher priority. */
  library?: string;
  /** Codegen-provided release/debug candidates used when no override is set. */
  libraryCandidates?: readonly string[];
  /** Cargo cdylib target used for bounded ancestor discovery after bundling. */
  libraryName?: string;
};

export type BunFfiRuntime = {
  engine: EngineClient;
  library: string;
  /**
   * rkyv V2 invoke 가 caller-buffer 변형(`rustra_ffi_invoke_rkyv_v2_into`)을
   * 사용하면 true — Rust 는 응답을 malloc 하지 않고 free 짝이 필요 없다.
   */
  usesCallerBufferInto: boolean;
  close(): void;
};

function bunLibraryCandidates(options: BunFfiEngineOptions): string[] {
  const explicit = process.env.RUSTRA_BUN_LIBRARY ?? options.library;
  if (explicit) return [explicit];
  const candidates = [...(options.libraryCandidates ?? [])];
  if (options.libraryName) {
    const extension =
      process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
    const prefix = process.platform === 'win32' ? '' : 'lib';
    const filename = `${prefix}${options.libraryName}.${extension}`;
    let current = resolve(process.cwd());
    while (true) {
      candidates.push(resolve(current, 'target', 'release', filename));
      candidates.push(resolve(current, 'target', 'debug', filename));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate));
}

/** Loads Rustra's stable C ABI directly through Bun FFI. */
export async function createBunFfiEngine(options: BunFfiEngineOptions): Promise<BunFfiRuntime> {
  const { dlopen, FFIType, toArrayBuffer } = await import('bun:ffi');
  const definitions = {
    rustra_mobile_init: { args: [], returns: FFIType.void },
    rustra_ffi_invoke_rkyv_v2: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    // caller-buffer 변형 — Rust 가 응답을 caller 버퍼에 직접 기록한다.
    // 반환 상태: 성공 = 기록 바이트 수, 버퍼 부족 = usize::MAX(필요 크기는
    // out_len 에, 응답은 코어 probe 캐시에). ffi.rs 의 rkyv V2 into 계약.
    rustra_ffi_invoke_rkyv_v2_into: {
      args: [FFIType.ptr, 'usize' as const, FFIType.ptr, 'usize' as const, FFIType.ptr],
      returns: 'usize' as const,
    },
    rustra_ffi_free: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.void,
    },
    rustra_ffi_get_schema: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    rustra_ffi_contract_hash: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
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
  // (Tier 1) caller-buffer 변형 — C++ typedInvokeTail 과 동일한 패턴. 재사용
  // 512B 버퍼로 바로 dispatch+write 하고(대부분의 응답이 여기서 끝난다),
  // 부족하면 usize::MAX 상태 + out_len 의 필요 크기로 정확히 1회 재시도한다.
  // 코어 probe 캐시가 같은 응답을 유지하므로 비멱등 핸들러도 정확히 1회만
  // 실행된다. Rust malloc/free 0회 — free 짝이 필요 없다.
  const callerBufferCapacity = 512;
  const callerBuffer = new Uint8Array(callerBufferCapacity);
  // 버퍼 부족 재시도 신호 — 코어가 반환하는 정확한 sentinel(usize::MAX,
  // C++ typedInvokeTail 의 `n == SIZE_MAX` 와 동일). 성공 상태는 기록 바이트 수.
  const statusOverflow = 0xffff_ffff_ffff_ffffn;
  const invokeRkyvV2Into = (payload: ArrayBuffer): ArrayBuffer => {
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
      // 정확한 크기 heap 버퍼로 1회 재시도 — 코어가 캐시한 같은 응답을 쓴다.
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
      // 전체 크기가 기록되면 fresh 버퍼를 그대로 소유 이전 — 복사 1회 생략.
      if (retried === BigInt(needed)) return large.buffer as ArrayBuffer;
      return large.slice(0, Number(retried)).buffer as ArrayBuffer;
    }
    if (status === 0n) {
      // written == 0 — 크기 0 응답. 코어 rkyv V2 프레임은 최소 8B 헤더라
      // 정상 경로에서는 없지만, 계약상 빈 owned 버퍼로 응답한다.
      return new ArrayBuffer(0);
    }
    return callerBuffer.slice(0, Number(status)).buffer as ArrayBuffer;
  };
  const native = {
    invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer {
      return invokeRkyvV2Into(payload);
    },
    getSchema(): ArrayBuffer {
      outLength[0] = 0n;
      return copyOwned(handle.symbols.rustra_ffi_get_schema(outLength));
    },
    getContractHash(): ArrayBuffer {
      outLength[0] = 0n;
      return copyOwned(handle.symbols.rustra_ffi_contract_hash(outLength));
    },
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
  return {
    engine: createRkyvV2Engine(native, rkyvV2Codecs, engineOptions),
    library,
    usesCallerBufferInto: true,
    close: () => handle.close(),
  };
}

export type BunBootstrap = {
  ready(): Promise<EngineClient>;
  dispose(): void;
};

/** Registers lazy, collision-safe Bun FFI setup for generated entrypoints. */
export function createBunBootstrap(options: BunFfiEngineOptions): BunBootstrap {
  let runtime: BunFfiRuntime | undefined;
  configureLazy(async () => {
    runtime = await createBunFfiEngine(options);
    return runtime.engine;
  });
  return {
    ready: ensureConfigured,
    dispose() {
      runtime?.close();
      runtime = undefined;
    },
  };
}
