// Phase 3 — Task 3.5 (F7): 필드 순서(postcard 선언 순서) 드리프트 감지 (TS 측).
//
// Rust 측 field_order_drift.rs 의 짝. postcard 는 필드를 *선언 순서*대로 직렬화
// 하므로, TS codegen 이 필드를 알파벳순으로 정렬하거나 Rust struct 순서가
// 바뀌면 wire 가 **조용히** 바뀌며 타입 에러도 나지 않는다 (Rust↔TS desync).
//
// `RegistryDemoOutput { ok, frozen, message }` (선언순 ≠ 알파벳순) 의 응답 프레임을
// 바이트 단위로 고정해 `rustraRegistryDemoCodec.decode` 가 같은 순서로 읽는지 증명.
// 아래 hex 는 Rust 측 PINNED_BODY 와 동일 계약이다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { rustraRegistryDemoCodec } from '../generated/rkyv-codecs.js';

function hexToBytes(hex: string): ArrayBuffer {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u.buffer;
}

// RegistryDemoOutput { ok:true, frozen:true, message:"drift" } 의 응답 프레임.
// 레이아웃: [ok_frame=01 @0][7B 0 @1..7][본체 @8]
// 본체(선언순 ok,frozen,message): 01 | 01 | 05 | "drift"(64 72 69 66 74)
// → Rust field_order_drift.rs 의 PINNED_BODY 와 동일.
const PINNED_FRAME_ALL_TRUE = '01000000000000000101056472696674';

// RegistryDemoOutput { ok:true, frozen:false, message:"x" } — ok/frozen 이 서로 달라
// swap 드리프트(ok↔frozen)를 잡는다. 본체: 01 | 00 | 01 | "x"(78)
const PINNED_FRAME_DISTINCT = '010000000000000001000178';

test('field-order: decode pinned non-alphabetical frame → {ok,frozen,message} (Rust 선언순)', () => {
  const r = rustraRegistryDemoCodec.decode(hexToBytes(PINNED_FRAME_ALL_TRUE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.ok, true);
  assert.equal(r.result?.frozen, true);
  assert.equal(r.result?.message, 'drift');
});

test('field-order: ok/frozen distinct values are not swapped', () => {
  // 코드젠이 ok 와 frozen 을 뒤바꿔 읽으면 {ok:false, frozen:true} 가 된다 — 잡아야 한다.
  const r = rustraRegistryDemoCodec.decode(hexToBytes(PINNED_FRAME_DISTINCT));
  assert.equal(r.ok, true);
  assert.equal(r.result?.ok, true, 'ok must decode as true');
  assert.equal(r.result?.frozen, false, 'frozen must decode as false (not swapped with ok)');
  assert.equal(r.result?.message, 'x');
});

test('field-order: alphabetical-order codec would mis-decode (드리프트 회귀 가드)', () => {
  // 의도: 본체 01|01|05|drift 를 *알파벳순*(frozen,message,ok) 으로 읽으면
  // frozen=01, message len=01 → message="\x05", ok='d'(≠0/1 → decode failure/wrong).
  // 현재 코드젠이 선언순으로 읽으므로 ok=true 가 나와야 한다. 이 단언이
  // 코드젠이 알파벳순으로 드리프트하면 즉시 실패한다.
  const r = rustraRegistryDemoCodec.decode(hexToBytes(PINNED_FRAME_ALL_TRUE));
  assert.equal(
    r.result?.ok,
    true,
    'if codegen drifted to alphabetical order, ok would not decode as true',
  );
});
