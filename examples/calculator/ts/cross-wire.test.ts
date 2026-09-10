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
// NOTE: 0.4.1 complex-codec tuple wire was count + elements; this is a
// wire break for consumers mixing old TS codecs with regenerated Rust.
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

// ── 2026-08-28 A2 후속: 복합 64-bit 경로(Vec<u64> + Option<i64>) 교차 와이어 ──
// Rust wire_fixtures.rs wide_agg 3종과 짝. 원소/옵션 레벨 uvar64/zigzag64 가
// 스트림 중간 7바이트 varint 경계를 넘는 값을 이어받는 것까지 고정한다.
// 참고: span 튜플과 마찬가지로 와이드 정수 명령은 0.4.1 complex-codec 와이어
// (count + elements)와 호환되지 않는다 — 구/신 코덱 혼용 금지.

import { wideAggCodec } from '../generated/rkyv-codecs.js';

const WIDEAGG_BOUNDARY_REQUEST =
  '1c0005017f80018180808080808010ffffffffffffffffff0101ffffffffffffffffff01';
const WIDEAGG_BOUNDARY_RESPONSE = '0100000000000000ffffffffffffffffff01f5ffffffffffffffff01';
const WIDEAGG_EMPTY_REQUEST = '1c000000';
const WIDEAGG_EMPTY_RESPONSE = '01000000000000000000';
const WIDEAGG_MULTIELEM_REQUEST = '1c000380808080018080808080018080808080808001010a';
const WIDEAGG_MULTIELEM_RESPONSE = '0100000000000000808080808080800110';

test('cross-wire wideAgg: Vec<u64> + Option<i64> boundary values mid-stream', () => {
  const req = wideAggCodec.encode({
    samples: [1, 127, 128, 9007199254740993n, 18446744073709551615n],
    offset: -9223372036854775808n,
  });
  assert.equal(
    bytesToHex(req),
    WIDEAGG_BOUNDARY_REQUEST,
    '1B/2B varint elements then two 10-byte LEB128 elements + Some(i64::MIN)',
  );
  const r = wideAggCodec.decode(hexToBytes(WIDEAGG_BOUNDARY_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.max, 18446744073709551615n, 'u64::MAX restored as bigint');
  assert.equal(r.result?.adjusted, -9223372036854775803n, 'i64::MIN + 5 restored');
});

test('cross-wire wideAgg: empty vec + None option', () => {
  const req = wideAggCodec.encode({ samples: [], offset: null });
  assert.equal(bytesToHex(req), WIDEAGG_EMPTY_REQUEST, 'len=0 then None tag 0');
  const r = wideAggCodec.decode(hexToBytes(WIDEAGG_EMPTY_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.max, 0);
  assert.equal(r.result?.adjusted, 0);
});

test('cross-wire wideAgg: multi-element 5/9/10-byte varints across mid-stream boundaries', () => {
  const req = wideAggCodec.encode({
    samples: [268435456, 34359738368, 562949953421312],
    offset: 5,
  });
  assert.equal(bytesToHex(req), WIDEAGG_MULTIELEM_REQUEST, '2^28/2^35/2^49 + Some(5)');
  const r = wideAggCodec.decode(hexToBytes(WIDEAGG_MULTIELEM_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.max, 562949953421312, '2^49 stays a safe number');
  assert.equal(r.result?.adjusted, 8, '5 + 3 elements');
});

// ── 2026-08-29 B2: Set(uniqueItems) 복합 경로 교차 와이어 ──
// Rust wire_fixtures.rs tag_set fixture 와 짝. 원시 요소 Set 도 와이어는
// 순서 보존 postcard seq 다 — TS encode 는 Set 이터레이션 순서 그대로
// ([...set] 계약, 정렬/중복제거 없음), decode 는 new Set(values) 로 복원.
// Rust BTreeSet 은 정렬 순서로 직렬화하지만 디코딩은 Set 이므로 순서 차이는
// 관측되지 않는다.

import { tagSetCodec } from '../generated/rkyv-codecs.js';

const TAGSET_REQUEST = '1d00030d1ed00f';
const TAGSET_RESPONSE = '01000000000000000303742d3705743130303003743135';

test('cross-wire tagSet: TS Set iteration-order encode matches Rust request wire', () => {
  // Rust BTreeSet {-7, 15, 1000} 은 정렬 순서 [-7, 15, 1000] 로 직렬화된다
  // (zigzag: 13, 30, 2000=LEB128 d0 0f). TS Set 을 같은 순서로 만들면 동일
  // 바이트여야 한다.
  const req = tagSetCodec.encode({ ids: new Set<bigint | number>([-7, 15, 1000]) });
  assert.equal(bytesToHex(req), TAGSET_REQUEST, 'sorted Set → same wire as Rust BTreeSet');
});

test('cross-wire tagSet: Set is order-preserving, not sorted — insertion order wins', () => {
  // 역순 삽입 Set 은 역순 그대로 인코딩된다(정렬 없음이 계약).
  const req = tagSetCodec.encode({ ids: new Set([1000, 15, -7]) });
  assert.equal(bytesToHex(req), '1d0003d00f1e0d', 'insertion order preserved');
});

test('cross-wire tagSet: Rust response → TS decode restores a real Set<string>', () => {
  const r = tagSetCodec.decode(hexToBytes(TAGSET_RESPONSE));
  assert.equal(r.ok, true);
  const tags = r.result?.tags;
  assert.ok(tags instanceof Set, 'tags must be a Set');
  assert.equal(tags.size, 3);
  assert.deepEqual([...tags], ['t-7', 't1000', 't15']);
});

// ── 2026-09-11 A5: 기능 타입 매트릭스 확장 교차 와이어 ──────────
// Rust wire_fixtures.rs 신규 블록과 짝. 태그 enum(unit + data 변형),
// 중첩 구조체, 결정론 맵(BTreeMap → Vec<string>), 대용량 페이로드를
// Rust 실측 hex 와 byte-exact 로 고정한다.

import { echoGroupsCodec, kindEchoCodec, processItemCodec } from '../generated/rkyv-codecs.js';

const KINDECHO_UNIT_REQUEST = '210000';
const KINDECHO_UNIT_RESPONSE = '010000000000000000';
const KINDECHO_SET_REQUEST = '21000109';
const KINDECHO_SET_RESPONSE = '01000000000000000109';
const PROCESSITEM_REQUEST = '0900010370656e78';
const PROCESSITEM_RESPONSE = '010000000000000000000d70726f6365737365645f70656ef001';
const ECHOGROUPS_REQUEST = '1b000201610101780162020179017a';
const ECHOGROUPS_RESPONSE = '01000000000000000201610101780162020179017a';
const SIZEOF_LARGE_RESPONSE = '010000000000000080a00b8010';

// kindEcho — serde 외부 태그 enum 의 postcard 변형 인덱스 와이어. unit 변형은
// 인덱스 한 바이트, struct 변형은 인덱스 + 필드. TS 표면은 serde JSON 과 같은
// 모양('Clear' 문자열 / {Set:{value}} 키 객체)이다.
test('cross-wire kindEcho unit variant: enum tag wire is a single variant index', () => {
  const req = kindEchoCodec.encode({ kind: 'Clear' });
  assert.equal(bytesToHex(req), KINDECHO_UNIT_REQUEST, 'Clear → variant index 0 only');
  const r = kindEchoCodec.decode(hexToBytes(KINDECHO_UNIT_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.echoed, 'Clear', 'unit variant restores as the bare string');
});

test('cross-wire kindEcho data variant: index + struct body on request and response', () => {
  const req = kindEchoCodec.encode({ kind: { Set: { value: -5 } } });
  assert.equal(bytesToHex(req), KINDECHO_SET_REQUEST, 'Set{value:-5} → index 1 + zigzag 9');
  const r = kindEchoCodec.decode(hexToBytes(KINDECHO_SET_RESPONSE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result?.echoed, { Set: { value: -5 } }, 'externally tagged shape restored');
});

// processItem — 중첩 구조체(Item{active,name,value}) + 응답 선언순
// (doubled, item). 코드젠이 알파벳순으로 드리프트하면 이 디코드가 깨진다.
test('cross-wire processItem: nested struct wire + declaration-order output', () => {
  const req = processItemCodec.encode({ item: { active: true, name: 'pen', value: 60 } });
  assert.equal(
    bytesToHex(req),
    PROCESSITEM_REQUEST,
    'bool + str len + zigzag in declaration order',
  );
  const r = processItemCodec.decode(hexToBytes(PROCESSITEM_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.doubled, false, '60 is not > 100');
  assert.deepEqual(
    r.result?.item,
    { active: false, name: 'processed_pen', value: 120 },
    'nested Item must decode with fields intact',
  );
});

// echoGroups — BTreeMap 은 정렬 순서로 직렬화되므로 요청 hex 도 결정론적이다
// (HashMap scoreTotal 과의 차이). 맵 → 시퀀스 중첩 와이어.
test('cross-wire echoGroups: sorted map → vec<string> wire is fully pinned', () => {
  const req = echoGroupsCodec.encode({ groups: { a: ['x'], b: ['y', 'z'] } });
  assert.equal(bytesToHex(req), ECHOGROUPS_REQUEST, 'count + (key, len + elements)* sorted');
  const r = echoGroupsCodec.decode(hexToBytes(ECHOGROUPS_RESPONSE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result?.groups, { a: ['x'], b: ['y', 'z'] });
});

// sizeOf 2KB — 대용량 페이로드 프레이밍: 길이 varint 2048→[80 10], 원시 복사,
// checksum 184320→[80 a0 0b]. 페이로드가 상수이므로 접두/길이/전체 내용으로 고정.
test('cross-wire sizeOf 2KB payload: length varint framing and raw copy', () => {
  const req = sizeOfCodec.encode({ data: Array<number>(2048).fill(0x5a) });
  const hex = bytesToHex(req);
  assert.equal(hex.slice(0, 8), '0e008010', 'cmd 14 LE + len varint 2048');
  assert.equal(hex.length, 4104, '2 cmd + 2 len + 2048 payload bytes');
  assert.ok(/^(5a)*$/.test(hex.slice(8)), 'payload must be a raw 0x5A copy (no re-framing inside)');
  const r = sizeOfCodec.decode(hexToBytes(SIZEOF_LARGE_RESPONSE));
  assert.equal(r.ok, true);
  assert.equal(r.result?.checksum, 184320, '0x5A * 2048');
  assert.equal(r.result?.len, 2048);
});
