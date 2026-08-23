import { dlopen, FFIType, suffix, CString, toArrayBuffer } from 'bun:ffi';
import { configure, createBunEngine } from '../../../packages/bun/src/index.js';
import { createRkyvV2Engine } from '../../../packages/types/src/index.js';
import { addNumbers } from '../generated/commands.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';

const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_calculator_invoke: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  rustra_calculator_free_string: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // rkyv V2 직결 — [cmd_id u16 LE][postcard(I)] 프레임을 포인터+길이로 주고
  // 응답 버퍼(ptr, *out_len)를 받는다. out_len는 8B 정렬 쓰기 스토리지를
  // 가리키는 세 번째 인자다. 해제 짝은 rustra_ffi_free 레이아웃의
  // rustra_calculator_free_rkyv_v2_buffer 다.
  rustra_calculator_invoke_rkyv_v2: {
    args: [FFIType.ptr, FFIType.usize, FFIType.ptr],
    returns: FFIType.ptr,
  },
  rustra_calculator_free_rkyv_v2_buffer: {
    args: [FFIType.ptr, FFIType.usize],
    returns: FFIType.void,
  },
});

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = Buffer.from(JSON.stringify({ command, args }) + '\0');
    const rawPtr = lib.symbols.rustra_calculator_invoke(payload);
    // CString은 native pointer view라 free 뒤 lazy coercion하면
    // use-after-free다. 호스트 소유 문자열로 복사한 뒤 해제한다.
    const rawResponse = new CString(rawPtr).toString();
    lib.symbols.rustra_calculator_free_string(rawPtr);

    const response = JSON.parse(rawResponse) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'invoke failed');
    }

    return response.result;
  },
});
configure(engine);

// rkyv V2 직결 엔진 — JSON/UTF-16 왕복 없이 postcard 프레임 왕복.
// out_len 수신용 스토리지 — Bun FFI의 ptr-to-usize는 단일 8B 메모리를 가리킨다.
const outLenBuf = new BigUint64Array(1);
const rkyvNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer {
    const req = Buffer.from(payload);
    const ptr = lib.symbols.rustra_calculator_invoke_rkyv_v2(
      req,
      BigInt(req.byteLength),
      outLenBuf,
    );
    if (ptr === 0) throw new Error('bun FFI rkyv V2 returned null');
    // toArrayBuffer(ptr, byteOffset, byteLength) — 외부 메모리를 JS로 복사한다.
    // Bun이 resizable ArrayBuffer를 돌려줄 수 있어 DataView 경계 계약과 어긋날
    // 수 있으므로 고정 크기 사본으로 정규화한다. 복사 뒤 Rust 버퍼를 해제한다.
    const outLen = Number(outLenBuf[0]);
    const copied = toArrayBuffer(ptr, 0, outLen);
    const frame = new ArrayBuffer(outLen);
    new Uint8Array(frame).set(new Uint8Array(copied));
    lib.symbols.rustra_calculator_free_rkyv_v2_buffer(ptr, BigInt(outLen));
    return frame;
  },
};
const rkyvEngine = createRkyvV2Engine(rkyvNative, rkyvV2Registry);
const rkyvResult = await rkyvEngine.invoke<{ value: number }>('addNumbers', { a: 40, b: 2 });
if (rkyvResult.value !== 42) {
  throw new Error(`bun FFI rkyv V2 round-trip failed: got ${JSON.stringify(rkyvResult)}`);
}

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`bun FFI result: ${result.value}`);
console.log(`bun FFI rkyv V2 result: ${rkyvResult.value}`);
