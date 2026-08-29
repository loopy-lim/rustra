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
    rustra_ffi_schema_generation: { args: [FFIType.ptr], returns: FFIType.ptr },
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
      if (retried === BigInt(needed)) return large.buffer as ArrayBuffer;
      return large.slice(0, Number(retried)).buffer as ArrayBuffer;
    }
    if (status === 0n) return new ArrayBuffer(0);
    if (status > callerBufferCapacity) {
      throw new RustraCommandError(
        'invoke.failed',
        `Bun FFI caller-buffer status exceeds capacity: ${status}`,
      );
    }
    return callerBuffer.slice(0, Number(status)).buffer as ArrayBuffer;
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
    // (T0-3) 레지스트리 세대 — 동적 명령 호출 전 스테일 캐시 게이트가 소비.
    getSchemaGeneration: () => {
      outLength[0] = 0n;
      return copyOwned(handle.symbols.rustra_ffi_schema_generation(outLength));
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
