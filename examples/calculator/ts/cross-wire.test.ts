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

test('encodeInto is byte-identical to encode across representative commands', () => {
  // 재사용 버퍼 직접 기록 경로(encodeInto)는 encode 와 완전히 같은 와이어를
  // 내야 한다 — 커맨드별 최근 버퍼 1개 재사용이 dispatch 핫패스에 들어가므로
  // 패리티가 깨지면 즉시 잡아야 한다. 부정수/멀티바이트 varint/문자열/배열로
  // 경계를 두루 친다.
  const cases: Array<
    [
      string,
      unknown,
      { encode(a: never): ArrayBuffer; encodeInto?(a: never, r?: Uint8Array): Uint8Array },
    ]
  > = [
    ['addNumbers', { a: 2, b: 3 }, addNumbersCodec],
    ['addNumbers neg', { a: -5, b: 100000 }, addNumbersCodec],
    ['greet', { name: '루스트 🎉' }, greetCodec],
    ['divide', { a: 7, b: 2 }, divideCodec],
  ];
  for (const [label, args, codec] of cases) {
    const fromEncode = new Uint8Array(codec.encode(args as never));
    const firstInto = codec.encodeInto!(args as never);
    const againInto = codec.encodeInto!(args as never, firstInto);
    for (const [variant, bytes] of [
      ['fresh', firstInto],
      ['reuse', againInto],
    ] as const) {
      assert.equal(
        bytes.length,
        fromEncode.length,
        `${label} (${variant}): encodeInto length must match encode`,
      );
      for (let i = 0; i < fromEncode.length; i++) {
        assert.equal(bytes[i], fromEncode[i], `${label} (${variant}) byte ${i}`);
      }
    }
  }
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

// ── 2026-08-22 타입 확장: bytes/map/tuple/uvar 교차 와이어 ──────
// Rust wire_fixtures.rs 신규 4종과 짝. probe 계약: u32/u64 plain varint,
// map count+(k,v)*, tuple 은 A2부터 postcard prefix-free(len + elements).

import { gaugeCodec, scoreTotalCodec, sizeOfCodec, spanCodec } from '../generated/rkyv-codecs.js';

const SIZEOF_REQUEST = '0e0004010203fa';
const SIZEOF_RESPONSE = '0100000000000000800204';
const SCORETOTAL_RESPONSE = '01000000000000000254';
const SPAN_REQUEST = '100002686909';
const SPAN_RESPONSE = '010000000000000002686909';
const GAUGE_REQUEST = '1100ac02f0a204';
const GAUGE_RESPONSE = '01000000000000009ca504';

// sizeOf — Vec<u8> len+raw (u32 출력 plain varint)
test('cross-wire sizeOf: TS encode → Rust request / Rust response → TS decode', () => {
  const req = sizeOfCodec.encode({ data: [1, 2, 3, 250] });
  assert.equal(bytesToHex(req), SIZEOF_REQUEST, 'bytes: len varint + raw');
  const r = sizeOfCodec.decode(hexToBytes(SIZEOF_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.checksum, 256, '1+2+3+250 = 256');
  assert.equal(r.result?.len, 4);
});

// scoreTotal — map count+(k,v)*. 요청은 해시 순서가 비결정적이라 hex 고정
// 불가(Rust 측 동일) — 엔트리 수/길이 구조 검증 + 응답 round-trip.
test('cross-wire scoreTotal: map structure + response round-trip', () => {
  const req = scoreTotalCodec.encode({ scores: { a: 10, b: 32 } });
  const u = new Uint8Array(req);
  assert.equal(u[0], 0x0f, 'cmd_id LSB (14)');
  assert.equal(u[1], 0x00, 'cmd_id MSB');
  assert.equal(u[2], 2, 'entry count = 2');
  assert.equal(u.length, 9, 'count(1) + 2 * (1+1 key + zigzag val)');
  const r = scoreTotalCodec.decode(hexToBytes(SCORETOTAL_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.total, 42);
  assert.equal(r.result?.count, 2);
});

// span — postcard tuple: prefix-free ("hi", -5) → str len + bytes + zigzag i64
test('cross-wire span: postcard tuple is prefix-free', () => {
  const req = spanCodec.encode({ pair: ['hi', -5] });
  assert.equal(bytesToHex(req), SPAN_REQUEST, 'postcard tuple: str len + bytes + zigzag i64');
  const r = spanCodec.decode(hexToBytes(SPAN_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.first, 'hi');
  assert.equal(r.result?.second, -5);
});

// gauge — u64/u32 plain varint (과거 zigzag 인코딩 버그의 회귀 방지)
test('cross-wire gauge: unsigned fields use plain varint, not zigzag', () => {
  const req = gaugeCodec.encode({ limit: 300, offset: 70000 });
  assert.equal(bytesToHex(req), GAUGE_REQUEST, '300 → ac02, 70000 → f0a204 (plain)');
  const r = gaugeCodec.decode(hexToBytes(GAUGE_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.next, 70300, '300 + 70000');
});

// ── 2026-08-28 A2: 와이드 정수 postcard fast-path 경계 교차 와이어 ──
// Rust wire_fixtures.rs 신규 3종과 짝. u64::MAX / i64::MIN / 2^53±1 값이
// uvar64/zigzag64 헬퍼로 number 손실 없이 왕복함을 증명한다.

const GAUGE_U64MAX_REQUEST = '1100ffffffffffffffffff0100';
const GAUGE_U64MAX_RESPONSE = '0100000000000000ffffffffffffffffff01';
const SPAN_I64MIN_REQUEST = '1000026869ffffffffffffffffff01';
const SPAN_I64MIN_RESPONSE = '0100000000000000026869ffffffffffffffffff01';
const SPAN_2POW53_M1_REQUEST = '1000026869feffffffffffff1f';
const SPAN_2POW53_M1_RESPONSE = '0100000000000000026869feffffffffffff1f';
const SPAN_2POW53_P1_REQUEST = '10000268698280808080808020';
const SPAN_2POW53_P1_RESPONSE = '01000000000000000268698280808080808020';

test('cross-wire gauge u64::MAX: 10-byte LEB128 round-trip', () => {
  const req = gaugeCodec.encode({ limit: 18446744073709551615n, offset: 0 });
  assert.equal(bytesToHex(req), GAUGE_U64MAX_REQUEST, 'u64::MAX → ff x9 + 01');
  const r = gaugeCodec.decode(hexToBytes(GAUGE_U64MAX_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.next, 18446744073709551615n, 'u64::MAX restored as bigint');
});

test('cross-wire span i64::MIN: worst-case zigzag (u64::MAX) round-trip', () => {
  const req = spanCodec.encode({ pair: ['hi', -9223372036854775808n] });
  assert.equal(bytesToHex(req), SPAN_I64MIN_REQUEST, 'zigzag(i64::MIN) = u64::MAX');
  const r = spanCodec.decode(hexToBytes(SPAN_I64MIN_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.second, -9223372036854775808n, 'i64::MIN restored as bigint');
});

test('cross-wire span 2^53-1: largest exact number', () => {
  const req = spanCodec.encode({ pair: ['hi', 9007199254740991] });
  assert.equal(bytesToHex(req), SPAN_2POW53_M1_REQUEST);
  const r = spanCodec.decode(hexToBytes(SPAN_2POW53_M1_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.second, 9007199254740991, 'stays a safe number');
});

test('cross-wire span 2^53+1: decode restores bigint beyond number precision', () => {
  const req = spanCodec.encode({ pair: ['hi', 9007199254740993n] });
  assert.equal(bytesToHex(req), SPAN_2POW53_P1_REQUEST);
  const r = spanCodec.decode(hexToBytes(SPAN_2POW53_P1_RESPONSE));
  assert.equal(r.ok, true);
  const second = r.result?.second;
  assert.equal(typeof second, 'bigint', 'unsafe value must come back as bigint');
  assert.equal(second, 9007199254740993n, 'exact 2^53+1, not the rounded number');
});
