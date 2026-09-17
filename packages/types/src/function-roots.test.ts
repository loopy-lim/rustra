import { test, expect } from 'bun:test';
import { createSchemaPostcardCodec } from './schema-postcard-codec.js';
import { createComplexCodec } from './complex-codec.js';
import type { ComplexSchema } from './complex-codec-types.js';
const i32 = { type: 'integer', format: 'int32' };
const tuple = (...items: ComplexSchema[]): ComplexSchema => ({
  type: 'array',
  items,
  minItems: items.length,
  maxItems: items.length,
});
const response = (...body: number[]) => Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, ...body);
test('root postcard tuple preserves exact bytes, arity, and unit shape', () => {
  const codec = createSchemaPostcardCodec(1, tuple(i32, i32), i32)!;
  expect([...new Uint8Array(codec.encode([2, 3]))]).toEqual([1, 0, 4, 6]);
  expect(codec.decode(response(10))).toEqual({ ok: true, result: 5 });
  expect(() => codec.encode([2])).toThrow('arity');
  expect(() => codec.encode([2, 3, 4])).toThrow('arity');
  const unit = createSchemaPostcardCodec(2, { type: 'null' }, { type: 'null' })!;
  expect([...new Uint8Array(unit.encode(undefined))]).toEqual([2, 0]);
  expect(unit.decode(response())).toEqual({ ok: true, result: undefined });
});
test('root postcard nested tuples, maps, optional roots, and f32 collections match Rust bytes', () => {
  const cases: [ComplexSchema, unknown, number[]][] = [
    [tuple(tuple(i32, { type: 'string' }), { type: 'boolean' }), [[4, 'x'], true], [8, 1, 120, 1]],
    [{ type: ['integer', 'null'], format: 'int32' }, null, [0]],
    [{ type: ['integer', 'null'], format: 'int32' }, 3, [1, 6]],
    [{ type: 'array', items: { type: 'number', format: 'float' } }, [1.5], [1, 0, 0, 192, 63]],
    [
      { type: 'object', additionalProperties: { type: 'number', format: 'float' } },
      { a: 1.5 },
      [1, 1, 97, 0, 0, 192, 63],
    ],
    [{ type: 'array', items: { type: 'array', items: i32 } }, [[1, 2], [3]], [2, 2, 2, 4, 1, 6]],
  ];
  for (const [schema, value, bytes] of cases) {
    const codec = createSchemaPostcardCodec(1, schema, schema)!;
    expect([...new Uint8Array(codec.encode(value))]).toEqual([1, 0, ...bytes]);
    expect(codec.decode(response(...bytes))).toEqual({ ok: true, result: value });
  }
});
test('complex root unit input accepts generated undefined and unit output normalizes', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: { type: 'null' },
    outputSchema: { type: 'null' },
  });
  expect([...new Uint8Array(codec.encode(undefined))]).toEqual([1, 0]);
  expect(codec.decode(response())).toEqual({ ok: true, result: undefined });
});
test('unsupported optional tuple and nested map agree with Rust complex route', () => {
  const optionalTuple = { anyOf: [tuple(i32, i32), { type: 'null' }] };
  expect(createSchemaPostcardCodec(1, optionalTuple, i32, {}, true)).toBeNull();
  expect(
    createSchemaPostcardCodec(
      1,
      { type: 'object', additionalProperties: { type: 'array', items: i32 } },
      i32,
      {},
      true,
    ),
  ).toBeNull();
  expect(
    createSchemaPostcardCodec(1, { type: 'array', items: i32, uniqueItems: true }, i32, {}, true),
  ).toBeNull();
});

test('root uint8 uses a single postcard byte at the high boundary', () => {
  const u8 = { type: 'integer', format: 'uint8' };
  const codec = createSchemaPostcardCodec(1, tuple(u8), u8)!;
  expect([...new Uint8Array(codec.encode([255]))]).toEqual([1, 0, 255]);
  expect(codec.decode(response(255))).toEqual({ ok: true, result: 255 });
});

test('fixed arrays inside argument tuples and return roots omit the Vec length prefix', () => {
  for (const [item, length, value, wire] of [
    [i32, 2, [8, 3], [16, 6]],
    [{ type: 'integer', format: 'uint8' }, 3, Uint8Array.of(0, 128, 255), [0, 128, 255]],
  ] as const) {
    const fixed = { type: 'array', items: item, minItems: length, maxItems: length };
    const codec = createSchemaPostcardCodec(1, tuple(fixed), fixed)!;
    expect([...new Uint8Array(codec.encode([value]))]).toEqual([1, 0, ...wire]);
    expect(codec.decode(response(...wire))).toEqual({ ok: true, result: value });
    expect(() => codec.encode([[1]])).toThrow('length');
  }
  const vector = createSchemaPostcardCodec(1, tuple({ type: 'array', items: i32 }), {
    type: 'array',
    items: i32,
  })!;
  expect([...new Uint8Array(vector.encode([[8, 3]]))]).toEqual([1, 0, 2, 16, 6]);
});

test('closed structs preserve postcard tuple fields under strict Rust routing', () => {
  const closed = {
    type: 'object',
    properties: { pair: tuple(i32, i32) },
    required: ['pair'],
    additionalProperties: false,
  };
  const codec = createSchemaPostcardCodec(1, closed, closed, {}, true)!;
  expect(codec).not.toBeNull();
  expect([...new Uint8Array(codec.encode({ pair: [8, 3] }))]).toEqual([1, 0, 16, 6]);
  expect(codec.decode(response(22, 10))).toEqual({ ok: true, result: { pair: [11, 5] } });
  for (const additionalProperties of [true, i32])
    expect(
      createSchemaPostcardCodec(1, { ...closed, additionalProperties }, closed, {}, true),
    ).toBeNull();
});

test('optional and vector reference depth matches Rust without charging the ref wrapper twice', () => {
  for (const vector of [false, true]) {
    const child = (name: string): ComplexSchema =>
      vector
        ? { type: 'array', items: { $ref: `#/definitions/${name}` } }
        : { anyOf: [{ $ref: `#/definitions/${name}` }, { type: 'null' }] };
    const definitions = {
      Outer: { type: 'object', properties: { child: child('Middle') } },
      Middle: { type: 'object', properties: { child: child('Leaf') } },
      Leaf: { type: 'object', properties: { n: i32 }, required: ['n'] },
    };
    const input = tuple({ $ref: '#/definitions/Outer' });
    const value = vector ? { child: [{ child: [{ n: 3 }] }] } : { child: { child: { n: 3 } } };
    const codec = createSchemaPostcardCodec(1, input, i32, definitions, true)!;
    expect(codec).not.toBeNull();
    expect([...new Uint8Array(codec.encode([value]))]).toEqual([1, 0, 1, 1, 6]);
    expect(codec.decode(response(6))).toEqual({ ok: true, result: 3 });
  }
});

test('int8 ordinary arguments and returns use raw signed postcard bytes', () => {
  const int8 = { type: 'integer', format: 'int8' };
  const codec = createSchemaPostcardCodec(1, tuple(int8), int8, {}, true)!;
  for (const [value, byte] of [
    [-128, 128],
    [-1, 255],
    [0, 0],
    [1, 1],
    [127, 127],
  ]) {
    expect([...new Uint8Array(codec.encode([value]))]).toEqual([1, 0, byte]);
    expect(codec.decode(response(byte))).toEqual({ ok: true, result: value });
  }
});

test('legacy root struct fields start at depth zero without resetting nested roots', () => {
  const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
  const definitions = {
    L1: { type: 'object', properties: { child: ref('L2') } },
    L2: { type: 'object', properties: { child: ref('L3') } },
    L3: { type: 'object', properties: { child: ref('L4') } },
    L4: { type: 'object', properties: { n: i32 } },
  };
  const root = { type: 'object', properties: { child: ref('L1'), pair: tuple(i32, i32) } };
  const value = { child: { child: { child: { child: { n: 3 } } } }, pair: [4, 5] };
  for (const closed of [root, { ...root, additionalProperties: false }]) {
    const codec = createSchemaPostcardCodec(1, closed, closed, definitions, true)!;
    expect(codec).not.toBeNull();
    expect([...new Uint8Array(codec.encode(value))]).toEqual([1, 0, 6, 8, 10]);
    expect(codec.decode(response(6, 8, 10))).toEqual({ ok: true, result: value });
  }
  expect(createSchemaPostcardCodec(1, tuple(root), root, definitions, true)).toBeNull();
  const deeper = {
    ...definitions,
    L4: { type: 'object', properties: { child: ref('L5') } },
    L5: { type: 'object', properties: { n: i32 } },
  };
  expect(createSchemaPostcardCodec(1, root, root, deeper, true)).toBeNull();
});
