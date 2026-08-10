// Phase 2 — Rust↔TS 교차 와이어 증명 (Task 2.2 + 2.3 + 2.6).
//
// Rust 측 `examples/calculator/tests/wire_fixtures.rs` 가 실제 `invoke_rkyv_v2`
// 로 만들어낸 canonical hex 를, **generated codec**(stub 아님)으로 양방향
// 교차 검증한다:
//   - Rust→TS : Rust 가 낸 response hex → TS codec.decode → 값 일치
//   - TS→Rust : TS codec.encode 결과 → Rust 가 기대하는 request hex 와 일치
//   - 에러    : Rust error frame hex → TS codec.decode → RustraError(code,message)
//
// hex 는 양쪽에서 동일해야 한다 — 한쪽 코덱/스키마가 드리프트하면 이 테스트가 실패한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { addNumbersCodec, divideCodec, greetCodec } from '../generated/rkyv-codecs.js';

// ── canonical hex (Rust wire_fixtures.rs 와 공유) ────────────
const ADDNUMBERS_REQUEST = '01000406';
const ADDNUMBERS_RESPONSE = '01000000000000000a';
const GREET_REQUEST = '0500044c796e78';
const GREET_RESPONSE = '01000000000000000c48656c6c6f2c204c796e7821';
const DIVIDE_REQUEST = '0a000200';
const DIVIDE_RESPONSE =
  '00000000000000002a00136d6174682e6469766964655f62795f7a65726f1563616e6e6f7420646976696465206279207a65726f';

function hexToBytes(hex: string): ArrayBuffer {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u.buffer;
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── addNumbers (Tier1 i64) ──────────────────────────────────

test('cross-wire addNumbers: Rust response → TS codec.decode', () => {
  const r = addNumbersCodec.decode(hexToBytes(ADDNUMBERS_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.value, 5, '2 + 3 must decode to 5');
});

test('cross-wire addNumbers: TS codec.encode → Rust request wire', () => {
  const req = addNumbersCodec.encode({ a: 2, b: 3 });
  assert.equal(bytesToHex(req), ADDNUMBERS_REQUEST, 'TS encode must match Rust request hex');
});

// ── greet (Tier2 String) ────────────────────────────────────

test('cross-wire greet: Rust response → TS codec.decode', () => {
  const r = greetCodec.decode(hexToBytes(GREET_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.message, 'Hello, Lynx!');
});

test('cross-wire greet: TS codec.encode → Rust request wire', () => {
  const req = greetCodec.encode({ name: 'Lynx' });
  assert.equal(bytesToHex(req), GREET_REQUEST);
});

// ── divide (에러 프레임 교차, Task 2.6) ─────────────────────

test('cross-wire divide: Rust error frame → TS codec.decode → RustraError', () => {
  const r = divideCodec.decode(hexToBytes(DIVIDE_RESPONSE));
  assert.equal(r.ok, false, 'divide-by-zero must decode as an error frame');
  assert.equal(r.error?.code, 'math.divide_by_zero');
  assert.equal(r.error?.message, 'cannot divide by zero');
});

test('cross-wire divide: TS codec.encode → Rust request wire', () => {
  const req = divideCodec.encode({ a: 1, b: 0 });
  assert.equal(bytesToHex(req), DIVIDE_REQUEST);
});

// ── 구조적 단언: success/error 프레임 레이아웃 ──────────────

test('cross-wire frame layout: success has ok=1 at byte 0, payload at offset 8', () => {
  const u = new Uint8Array(hexToBytes(ADDNUMBERS_RESPONSE));
  assert.equal(u[0], 1, 'success frame ok=1');
  // offset 1..7 reserved(0)
  assert.deepEqual(Array.from(u.slice(1, 8)), [0, 0, 0, 0, 0, 0, 0]);
});

test('cross-wire frame layout: error has ok=0, err_len u16 LE @8, body @10', () => {
  const buf = hexToBytes(DIVIDE_RESPONSE);
  const u = new Uint8Array(buf);
  const view = new DataView(buf);
  assert.equal(u[0], 0, 'error frame ok=0');
  const errLen = view.getUint16(8, true);
  assert.equal(errLen + 10, u.length, 'err_len must exactly span the postcard body');
});
