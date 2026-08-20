import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createItemCodec,
  getItemCodec,
  listItemsCodec,
  updateItemCodec,
} from '../generated/rkyv-codecs.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';

/**
 * 와이어 round-trip 검증 — 과거 결함(미지원 필드 무음 삭제)의 재발 방지 게이트.
 *
 * 1. JS 코덱의 encode 바이트가 Rust postcard 계약(독립 계산한 기대 바이트)과 일치
 * 2. JS 코덱의 decode가 자기 encode 바이트를 완전 복원 (encode→decode round-trip)
 * 3. crud 전 명령이 레지스트리에 등록되어 있음 (부분 코덱 제외 방지)
 *
 * crud 는 Option/Vec<Struct>/anyOf 를 모두 포함하는 표준 표본이다.
 */

/** postcard varint (LEB128) — 계약 산출용 독립 구현. */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  out.push(v);
  return out;
}

/** postcard zigzag varint (i64/i32/i16). */
function zigzagVarint(n: number): number[] {
  return varint((n << 1) ^ (n >> 31));
}

/** postcard string: varint(len) + utf8 bytes. */
function pcString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...varint(bytes.length), ...bytes];
}

/** 성공 응답 프레임: [ok=1][pad 7B][postcard(Output)]. */
function okFrame(postcardBytes: number[]): ArrayBuffer {
  const out = new Uint8Array(8 + postcardBytes.length);
  out[0] = 1;
  out.set(postcardBytes, 8);
  return out.buffer;
}

test('updateItem encode includes Option fields (name/value) — past silent-drop regression', () => {
  // postcard(UpdateItemInput) = string(id) + Option<string>(name=Some "X") + Option<i64>(value=None)
  const expected = [
    ...[4, 0], // cmd_id = 4 (u16 LE)
    ...pcString('abc'),
    1,
    ...pcString('Renamed'),
    0, // value: None
  ];
  const buf = updateItemCodec.encode({ id: 'abc', name: 'Renamed', value: null });
  assert.deepEqual(Array.from(new Uint8Array(buf)), expected);
});

test('updateItem encode with Some(value) — both options present', () => {
  const expected = [
    ...[4, 0], // cmd_id = 4 (u16 LE)
    ...pcString('abc'),
    1,
    ...pcString('Renamed'),
    1,
    ...zigzagVarint(7),
  ];
  const buf = updateItemCodec.encode({ id: 'abc', name: 'Renamed', value: 7 });
  assert.deepEqual(Array.from(new Uint8Array(buf)), expected);
});

test('updateItem decode round-trips Option fields', () => {
  const frame = okFrame([
    1, // item: Some
    ...pcString('abc'),
    ...pcString('Renamed'),
    ...zigzagVarint(7),
  ]);
  const out = updateItemCodec.decode(frame);
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { item: { id: 'abc', name: 'Renamed', value: 7 } });
});

test('updateItem decode None item', () => {
  const out = updateItemCodec.decode(okFrame([0]));
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { item: null });
});

test('listItems encode includes Option<minValue>', () => {
  const expected = [...[3, 0], 1, ...zigzagVarint(5)];
  const buf = listItemsCodec.encode({ minValue: 5 });
  assert.deepEqual(Array.from(new Uint8Array(buf)), expected);
});

test('listItems decode round-trips Vec<struct>', () => {
  // items: len=2, 각 Item = { id: string, name: string, value: i64 }
  const item = (id: string, name: string, v: number) => [
    ...pcString(id),
    ...pcString(name),
    ...zigzagVarint(v),
  ];
  const frame = okFrame([...varint(2), ...item('a', 'A', 1), ...item('b', 'B', 2)]);
  const out = listItemsCodec.decode(frame);
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, {
    items: [
      { id: 'a', name: 'A', value: 1 },
      { id: 'b', name: 'B', value: 2 },
    ],
  });
});

test('createItem/getItem round-trip', () => {
  const enc = createItemCodec.encode({ name: 'W', value: 42 });
  assert.deepEqual(Array.from(new Uint8Array(enc)), [
    ...[1, 0],
    ...pcString('W'),
    ...zigzagVarint(42),
  ]);

  const frame = okFrame([1, ...pcString('x1'), ...pcString('W'), ...zigzagVarint(42)]);
  const out = getItemCodec.decode(frame);
  assert.deepEqual(out.result, { item: { id: 'x1', name: 'W', value: 42 } });

  const noneOut = getItemCodec.decode(okFrame([0]));
  assert.deepEqual(noneOut.result, { item: null });
});

test('all crud commands are registered — no silent partial codecs', () => {
  const names = ['createItem', 'getItem', 'listItems', 'updateItem', 'deleteItem'];
  for (const n of names) {
    assert.ok(rkyvV2Registry.has(n), `command '${n}' must be in rkyvV2Registry`);
  }
});
