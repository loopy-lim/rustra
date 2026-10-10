/// <reference path="../scriptc/scriptc-ffi.d.ts" />
// scriptc build 가 이 참조를 program 진입으로 요구한다(--external-types 는
// coverage 전용). eslint 예외 사유는 eslint.config.js 참조.

// scriptc Native FFI 스모크 — 코드젠 매니페스트(ffi_format 7)가 커밋 그대로 통하는
// 정적 링크 경로를 증명한다. uniform 초기화(rustra::native_entry! 진입) 1회 후
// caller-buffer envelope 진입(rustra_ffi_invoke_json_into_len)으로 addNumbers 를
// 호출한다. payload 는 string 클래스(scriptc 가 NUL-free UTF-8 로 인코딩해
// (ptr,len) 쌍으로 전달), buf 는 mutable-bytes(쓰기 가능한 borrow, len=capacity)다.
// 길이는 out 포인터 없이 u64 반환으로 온다 — usize::MAX(0xffff_ffff_ffff_ffff)가
// 유일한 실패 신호다.
rustra_mobile_init();

const decoder = new TextDecoder();
const input = JSON.stringify({ command: 'addNumbers', args: { a: 20, b: 22 } });
const outputBuffer = new Uint8Array(4096);
const written = rustra_ffi_invoke_json_into_len(input, outputBuffer);
if (written === 0xffff_ffff_ffff_ffffn) {
  throw new Error('FFI invocation failed (usize::MAX) — payload malformed or buffer too small');
}
if (written === 0n || written > BigInt(outputBuffer.length)) {
  throw new Error(`implausible response length: ${written}`);
}
const response = JSON.parse(decoder.decode(outputBuffer.subarray(0, Number(written))));
const result = response.result ?? response;
if (result.value !== 42) throw new Error(`expected 42, got ${result.value}`);
console.log(`scriptc FFI zero-config result: ${result.value}`);
