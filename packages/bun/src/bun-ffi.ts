import {
  configureLazy,
  createRkyvV2Engine,
  ensureConfigured,
  RustraErrorCode,
  RustraCommandError,
  type RkyvV2Engine,
} from '@rustra/types';
import type { Pointer } from 'bun:ffi';
import {
  bunLibraryCandidates,
  type BunFfiEngineOptions,
  type BunFfiRuntime,
} from './bun-ffi-library.js';

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

export type BunBootstrap = { ready(): Promise<RkyvV2Engine>; dispose(): void };

export function createBunBootstrap(options: BunFfiEngineOptions): BunBootstrap {
  let runtime: BunFfiRuntime | undefined;
  configureLazy(async () => {
    runtime = await createBunFfiEngine(options);
    return runtime.engine;
  });
  return {
    ready: () => ensureConfigured() as Promise<RkyvV2Engine>,
    dispose() {
      runtime?.close();
      runtime = undefined;
    },
  };
}
