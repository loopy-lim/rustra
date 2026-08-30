// ── 와이어 역호환 golden fixture 게이트 ──────────────────────
//
// docs/versioning-policy.md 의 "Wire format" 행이 보장하는 것 — *공개된 스키마에
// 대해 만들어진 바이트는 이후 버전의 코덱으로도 디코드된다* — 를 complex 라우트
// (createComplexCodec) golden fixture 로 고정한다.
//
// 기존 PINNED 계열과의 역할 분담:
//   - examples/calculator/ts/cross-wire.test.ts + examples/calculator/tests/
//     wire_fixtures.rs — 코드젠 코덱의 Rust↔TS 교차 와이어 (2026-08-22~29 공유 hex)
//   - examples/calculator/ts/field-order-drift.test.ts — 필드 선언순 드리프트 감지
//   - packages/types/src/index.test.ts schema-codec 블록 — postcard 인터프리터가
//     코드젠 코덱과 바이트 동일임을 같은 canonical hex 로 고정
//   - packages/types/src/complex-codec.test.ts — complex 코덱 동작 + 소수 byte pin
// 이 파일이 새로 담당하는 것은 complex 코덱 표면의 **골든 커버리지**다: 구조체
// (primitive/nested/optional presence), Option some/none(중첩 포함), 데이터 enum
// (unit+payload), 원시값 map / struct-valued map, tuple, Vec<u8>, Set, ISO-8601
// 날짜 문자열. hex 는 현재 인코더 출력을 무검증으로 얼린 게 아니라
// complex-codec-encode-node.ts (Rust complex_serde_ser_*.rs 와 바이트 동일 계약)의
// 알고리즘을 손으로 따라가 각 바이트 그룹을 주석으로 검증한 값이다. varint/zigzag
// 관례는 기존 PINNED hex(300→ac02, -5→09)와 교차 확인했다.
//
// 각 케이스는 원칙적으로 양방향: decode(hex) → 값 **AND** encode(값) → hex
// (round-trip 가드). decode-only 예외는 2개이고 각각 이유를 주석으로 남겼다:
//   - 비정렬 map 키 순서 — 구 Rust HashMap 프로듀서는 해시 순서로 엔트리를 쓸 수
//     있다. TS 인코더는 정렬해서 인코딩하므로(계약) encode 단언을 의도적으로 생략.
//   - Option<Option<T>> = Some(None) 와이어(01 00) — JS 값으로는 null 로 붕괴되며
//     새 인코더는 null 에 outer-None(00)만 낸다. 구 프로듀서 바이트의 디코드만 계약.
//
// 프레임 레이아웃(complex-codec.ts 계약):
//   request  = [cmd_id: u16 LE][postcard(Input)]
//   response = [ok=1][7B reserved 0][postcard(Output) @8]
//
// 픽스처는 총량이 작아 인라인 상수로 충분하다(별도 fixtures/ 디렉터리 불필요).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createComplexCodec } from './complex-codec.js';

function hexToBytes(hex: string): ArrayBuffer {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u.buffer;
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeHex(
  codec: { decode(b: ArrayBuffer): { ok: boolean; result?: unknown } },
  hex: string,
) {
  const r = codec.decode(hexToBytes(hex));
  assert.equal(r.ok, true, `golden hex must decode: ${hex}`);
  return r.result;
}

// ── 1. primitive struct 필드 — int varint, string, f64, optional presence,
//       ISO-8601 날짜 문자열 ─────────────────────────────────
// 이 저장소 런타임에는 chrono 타입이 없어 날짜/시각은 ISO-8601 문자열
// (str len+utf8)로 와이어에 오른다 — born_on 이 그 케이스.
// 와이어 필드 순서 = 프로퍼티 **선언순**(field-order-drift.test.ts 의 교훈).

const legacyRecordSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', format: 'uint32' }, // plain varint
    label: { type: 'string' }, // varint len + utf8
    ratio: { type: 'number' }, // f64 LE 8B
    nickname: { type: 'string' }, // optional → presence 바이트 1B
    born_on: { type: 'string' }, // chrono NaiveDate → "2024-01-15"
  },
  required: ['id', 'label', 'ratio', 'born_on'],
};

test('backcompat struct: uint32 varint + string + f64 + optional presence + ISO date', () => {
  const codec = createComplexCodec({
    commandId: 21,
    inputSchema: legacyRecordSchema,
    outputSchema: legacyRecordSchema,
  });

  // nickname 없음 — { id:300, label:"core", ratio:0.5, born_on:"2024-01-15" }
  // 본체(선언순): ac02(id 300=0x12c → LEB128 ac 02)
  //            | 04 636f7265("core")
  //            | 000000000000e03f(f64 0.5 = 0x3FE0000000000000, LE 8B)
  //            | 00(nickname presence 0)
  //            | 0a 323032342d30312d3135(len 10, "2024-01-15")
  const value1 = { id: 300, label: 'core', ratio: 0.5, born_on: '2024-01-15' };
  const request1 = '1500ac0204636f7265000000000000e03f000a323032342d30312d3135';
  const response1 = '0100000000000000ac0204636f7265000000000000e03f000a323032342d30312d3135';
  assert.deepEqual(
    decodeHex(codec, response1),
    value1,
    'struct golden (nickname absent) must decode',
  );
  assert.equal(bytesToHex(codec.encode(value1)), request1, 'struct encode (nickname absent)');

  // nickname 있음 — "rúst" 는 UTF-8 5바이트(72 c3 ba 73 74), presence 1.
  const value2 = { id: 300, label: 'core', ratio: 0.5, nickname: 'rúst', born_on: '2024-01-15' };
  const request2 = '1500ac0204636f7265000000000000e03f010572c3ba73740a323032342d30312d3135';
  const response2 =
    '0100000000000000ac0204636f7265000000000000e03f010572c3ba73740a323032342d30312d3135';
  assert.deepEqual(decodeHex(codec, response2), value2, 'struct golden (nickname present)');
  assert.equal(bytesToHex(codec.encode(value2)), request2, 'struct encode (nickname present)');
});

// ── 2. nested struct — required 중첩 + 내부 optional presence ──

const nestedSchema = {
  type: 'object',
  properties: {
    outer: { type: 'integer', format: 'uint8' }, // plain varint
    inner: {
      type: 'object',
      properties: {
        depth: { type: 'integer', format: 'int16' }, // zigzag
        tag: { type: 'string' }, // optional
      },
      required: ['depth'],
    },
  },
  required: ['outer', 'inner'],
};

test('backcompat nested struct: zigzag inner + optional presence', () => {
  const codec = createComplexCodec({
    commandId: 22,
    inputSchema: nestedSchema,
    outputSchema: nestedSchema,
  });
  // { outer:7, inner:{ depth:-1 } }
  // 본체: 07(outer) | 01(zigzag(-1)=1) | 00(tag presence 0)
  const value = { outer: 7, inner: { depth: -1 } };
  assert.deepEqual(decodeHex(codec, '0100000000000000070100'), value, 'nested struct golden');
  assert.equal(bytesToHex(codec.encode(value)), '1600070100', 'nested struct encode');
});

// ── 3. Option some/none — anyOf[X,null] 과 type 배열 두 표기 모두 ──

const optionSchema = {
  type: 'object',
  properties: {
    maybe: { anyOf: [{ type: 'integer', format: 'int32' }, { type: 'null' }] },
    label: { type: ['string', 'null'] },
  },
  required: ['maybe', 'label'],
};

test('backcompat option: Some/None presence tags for anyOf and type-array notation', () => {
  const codec = createComplexCodec({
    commandId: 23,
    inputSchema: optionSchema,
    outputSchema: optionSchema,
  });
  // { maybe:-2, label:"ok" } → 01(Some)+03(zigzag(-2)=3) | 01(Some)+02 6f6b("ok")
  const some = { maybe: -2, label: 'ok' };
  assert.deepEqual(decodeHex(codec, '0100000000000000010301026f6b'), some, 'option Some golden');
  assert.equal(bytesToHex(codec.encode(some)), '1700010301026f6b', 'option Some encode');

  // { maybe:null, label:"x" } → 00(None) | 01+01 78("x")
  const mixed = { maybe: null, label: 'x' };
  assert.deepEqual(decodeHex(codec, '010000000000000000010178'), mixed, 'option None golden');
  assert.equal(bytesToHex(codec.encode(mixed)), '170000010178', 'option mixed encode');
});

// ── 3b. 중첩 Option — Option<Option<uint16>> ────────────────
// None=00, Some(None)=01 00, Some(Some(v))=01 01 v. JS 값으로는 None 과
// Some(None) 이 둘 다 null 로 붙는다 — 와이어에서만 구별되는 자리.

const nestedOptionSchema = {
  type: 'object',
  properties: {
    maybe: {
      anyOf: [
        { anyOf: [{ type: 'integer', format: 'uint16' }, { type: 'null' }] },
        { type: 'null' },
      ],
    },
  },
  required: ['maybe'],
};

test('backcompat nested option: Some(Some(300)) round-trips, Some(None) decodes only', () => {
  const codec = createComplexCodec({
    commandId: 30,
    inputSchema: nestedOptionSchema,
    outputSchema: nestedOptionSchema,
  });
  // Some(Some(300)) → 01 01 + ac02(varint 300)
  assert.deepEqual(
    decodeHex(codec, '01000000000000000101ac02'),
    { maybe: 300 },
    'nested option Some(Some) golden',
  );
  assert.equal(bytesToHex(codec.encode({ maybe: 300 })), '1e000101ac02', 'nested option encode');

  // None → 00 — round-trip 가능(인코더도 null 에 00 을 낸다).
  assert.deepEqual(decodeHex(codec, '010000000000000000'), { maybe: null }, 'nested option None');
  assert.equal(bytesToHex(codec.encode({ maybe: null })), '1e0000', 'None encode');

  // Some(None) → 01 00 — decode-only. 구 Rust 프로듀서의 Option<Option<T>>
  // 와이어는 JS null 로 붕괴되어 디코드되어야 하고, 새 TS 인코더는 null 에
  // outer-None(00)을 내므로 encode 단언은 의도적으로 생략한다(왜곡된 바이트를
  // 얼리는 일이 아니라 구 와이어 수용 계약만 고정).
  assert.deepEqual(
    codec.decode(hexToBytes('01000000000000000100')),
    { ok: true, result: { maybe: null } },
    'Some(None) wire (01 00) must decode to null like None (00)',
  );
});

// ── 4. 데이터 enum — unit 변형 + payload 변형 ────────────────
// 변형 키('Done'<'Idle'<'Point' UTF-8순)로 정렬된 인덱스를 쓴다 — oneOf 선언순이
// 아니다(complex-codec.test.ts 의 "independently of oneOf order" 계약).

const shapeSchema = {
  oneOf: [
    { type: 'string', enum: ['Idle'] },
    {
      type: 'object',
      properties: {
        Point: {
          type: 'object',
          properties: {
            x: { type: 'integer', format: 'int32' },
            y: { type: 'integer', format: 'int32' },
          },
          required: ['x', 'y'],
        },
      },
      required: ['Point'],
    },
    { type: 'string', enum: ['Done'] },
  ],
};

test('backcompat data enum: sorted variant indexes, unit and payload variants', () => {
  const codec = createComplexCodec({
    commandId: 24,
    inputSchema: shapeSchema,
    outputSchema: shapeSchema,
  });
  // 정렬 순서 [Done, Idle, Point].
  // 'Done'(index 0) → 00 — unit 변형은 인덱스 외 본체 바이트 없음.
  assert.deepEqual(decodeHex(codec, '010000000000000000'), 'Done', 'unit variant index 0');
  assert.equal(bytesToHex(codec.encode('Done')), '180000', 'unit variant encode');
  // 'Idle'(index 1) → 01
  assert.deepEqual(decodeHex(codec, '010000000000000001'), 'Idle', 'unit variant index 1');
  assert.equal(bytesToHex(codec.encode('Idle')), '180001', 'unit variant encode');
  // {Point:{x:3,y:-4}}(index 2) → 02 + zigzag(3)=06 + zigzag(-4)=07
  const point = { Point: { x: 3, y: -4 } };
  assert.deepEqual(decodeHex(codec, '0100000000000000020607'), point, 'payload variant golden');
  assert.equal(bytesToHex(codec.encode(point)), '1800020607', 'payload variant encode');
});

// ── 5. 원시값 map — count + (str key, value)*, TS 인코더는 키 UTF-8 정렬 ──

const mapSchema = {
  type: 'object',
  properties: {
    counts: { type: 'object', additionalProperties: { type: 'integer', format: 'uint32' } },
  },
  required: ['counts'],
};

test('backcompat primitive map: count-prefixed, encoder sorts keys by UTF-8', () => {
  const codec = createComplexCodec({
    commandId: 25,
    inputSchema: mapSchema,
    outputSchema: mapSchema,
  });
  // { counts:{ b:1, a:300 } } → 본체 02(count) | 01 61("a")+ac02(300) | 01 62("b")+01
  // 삽입순 b,a 와 무관하게 인코더가 a,b 로 정렬한다.
  const value = { counts: { b: 1, a: 300 } };
  assert.deepEqual(
    decodeHex(codec, '0100000000000000020161ac02016201'),
    { counts: { a: 300, b: 1 } },
    'sorted map decode',
  );
  assert.equal(bytesToHex(codec.encode(value)), '1900020161ac02016201', 'sorted map encode');

  // 비ASCII 키 — UTF-8 바이트 순서 ≠ UTF-16 코드유닛 순서. U+FFFD(effbfbd)는
  // U+1F400(f09f9080)보다 *바이트순*으로 앞서지만, 기본 .sort() (UTF-16 코드유닛,
  // 서러게이트쌍 U+1F400 이 앞섬)과는 갈라진다. compareUtf8 이 기본 .sort() 로
  // 드리프트하면 이 encode 단언이 red 가 된다.
  // 본체: 02(count) | 03 efbfbd("�")+ac02(300) | 04 f09f9080("\u{1F400}")+01
  const unicodeValue = { counts: { '\u{1F400}': 1, '�': 300 } };
  assert.deepEqual(
    decodeHex(codec, '01000000000000000203efbfbdac0204f09f908001'),
    { counts: { '�': 300, '\u{1F400}': 1 } },
    'non-ASCII map keys decode in UTF-8 byte order',
  );
  assert.equal(
    bytesToHex(codec.encode(unicodeValue)),
    '19000203efbfbdac0204f09f908001',
    'non-ASCII keys encode in UTF-8 byte order, not UTF-16 sort',
  );
});

test('backcompat primitive map: unsorted old-wire entry order decodes (decode-only)', () => {
  // 구 Rust HashMap 프로듀서는 해시 순서로 엔트리를 쓸 수 있다 — 정렬되지 않은
  // 순서(b 먼저)의 와이어도 디코드돼야 한다. TS 인코더는 정렬 순서를 내므로 이
  // 케이스는 encode 단언을 의도적으로 생략한 decode-only 골든이다.
  const codec = createComplexCodec({
    commandId: 32,
    inputSchema: mapSchema,
    outputSchema: mapSchema,
  });
  // 02(count) | 01 62("b")+01 | 01 61("a")+ac02(300) — b,a 순서 와이어.
  assert.deepEqual(
    codec.decode(hexToBytes('0100000000000000020162010161ac02')),
    { ok: true, result: { counts: { b: 1, a: 300 } } },
    'unsorted old-wire map entry order must decode',
  );
});

// ── 6. struct-valued map — $ref 정의를 값으로 갖는 map ───────

const metricMapSchema = {
  type: 'object',
  properties: {
    metrics: { type: 'object', additionalProperties: { $ref: '#/definitions/Metric' } },
  },
  required: ['metrics'],
};
const metricSchema = {
  type: 'object',
  properties: {
    unit: { type: 'string' },
    value: { type: 'integer', format: 'int32' }, // zigzag
  },
  required: ['unit', 'value'],
};

test('backcompat struct-valued map: $ref values decode and re-encode byte-identical', () => {
  const codec = createComplexCodec({
    commandId: 31,
    inputSchema: metricMapSchema,
    outputSchema: metricMapSchema,
    definitions: { Metric: metricSchema },
  });
  // { metrics: { one:{ unit:"ms", value:5 } } }
  // 본체: 01(count) | 03 6f6e65("one") | 02 6d73("ms") + 0a(zigzag(5)=10)
  const value = { metrics: { one: { unit: 'ms', value: 5 } } };
  assert.deepEqual(
    decodeHex(codec, '010000000000000001036f6e65026d730a'),
    value,
    'struct-valued map golden',
  );
  assert.equal(bytesToHex(codec.encode(value)), '1f0001036f6e65026d730a', 'struct map encode');
});

// ── 7. tuple — complex 라우트는 count + elements ────────────
// complex 라우트 tuple 와이어는 count 프리픽스가 있다(Rust complex serialize_tuple
// → serialize_seq(Some(len))). postcard fast-path 라우트(span cross-wire)는
// prefix-free — 라우트별로 각각 안정 계약이며 혼용 금지는 migration 노트 참조.

const tupleSchema = {
  type: 'object',
  properties: {
    pair: {
      type: 'array',
      items: [{ type: 'string' }, { type: 'integer', format: 'int64' }],
      minItems: 2,
      maxItems: 2,
    },
  },
  required: ['pair'],
};

test('backcompat tuple: count-prefixed complex wire for (String, i64)', () => {
  const codec = createComplexCodec({
    commandId: 26,
    inputSchema: tupleSchema,
    outputSchema: tupleSchema,
  });
  // ['hi', -5] → 02(count) | 02 6869("hi") | 09(zigzag(-5)=9)
  const value = { pair: ['hi', -5] };
  assert.deepEqual(decodeHex(codec, '01000000000000000202686909'), value, 'tuple golden');
  assert.equal(bytesToHex(codec.encode(value)), '1a000202686909', 'tuple encode');
});

// ── 8. Vec<u8> bytes — complex 라우트는 varint 원소 시퀀스 ────
// serde Vec<T> 는 serialize_seq 로 나가므로 complex 라우트 bytes = count + 원소별
// plain varint. len+raw 특례는 postcard fast-path 라우트 전용이다.

const bytesSchema = {
  type: 'object',
  properties: { data: { type: 'array', items: { type: 'integer', format: 'uint8' } } },
  required: ['data'],
};

test('backcompat Vec<u8>: count + per-element plain varint', () => {
  const codec = createComplexCodec({
    commandId: 27,
    inputSchema: bytesSchema,
    outputSchema: bytesSchema,
  });
  // [0, 1, 255] → 03(count) | 00 | 01 | ff01(255 = LEB128 2바이트)
  const value = { data: [0, 1, 255] };
  assert.deepEqual(decodeHex(codec, '0100000000000000030001ff01'), value, 'Vec<u8> golden');
  assert.equal(bytesToHex(codec.encode(value)), '1b00030001ff01', 'Vec<u8> encode');
});

// ── 9. Set(uniqueItems) — 이터레이션 순서 보존, decode 는 Set 복원 ──

const setSchema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
  required: ['tags'],
};

test('backcompat Set: insertion-order wire, decode restores a real Set', () => {
  const codec = createComplexCodec({
    commandId: 33,
    inputSchema: setSchema,
    outputSchema: setSchema,
  });
  // Set(['b','a']) → 02(count) | 01 62("b") | 01 61("a") — 정렬 없음(삽입순 계약).
  const value = { tags: new Set(['b', 'a']) };
  const decoded = decodeHex(codec, '01000000000000000201620161') as { tags: Set<string> };
  assert.ok(decoded.tags instanceof Set, 'uniqueItems must restore a Set');
  assert.deepEqual([...decoded.tags], ['b', 'a'], 'Set insertion order preserved');
  assert.equal(bytesToHex(codec.encode(value)), '21000201620161', 'Set encode');
});
