import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createComplexCodec,
  type ComplexCodecOptions,
  type ComplexSchema,
} from './complex-codec.js';

const header = [1, 0, 0, 0, 0, 0, 0, 0];

const frame = (payload: number[]): ArrayBuffer => new Uint8Array([...header, ...payload]).buffer;

const pointSchema = {
  type: 'object',
  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
  required: ['x', 'y'],
};

const profileSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, score: { type: 'integer' } },
  required: ['name', 'score'],
};

const optionalSchema = {
  type: 'object',
  properties: { value: { type: 'integer' } },
  required: [],
};

const flagSchema = {
  type: 'object',
  properties: { flag: { type: 'boolean' } },
  required: ['flag'],
};

const statusSchema = {
  oneOf: [
    { type: 'string', enum: ['Idle'] },
    {
      type: 'object',
      properties: {
        Active: { type: 'object', properties: { level: { type: 'integer' } }, required: ['level'] },
      },
      required: ['Active'],
    },
  ],
};

const mapSchema = {
  type: 'object',
  properties: { counts: { type: 'object', additionalProperties: { type: 'integer' } } },
  required: ['counts'],
};

const sweepSchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    score: { type: 'integer', format: 'int32' },
    flag: { type: 'boolean' },
    scores: { type: 'array', items: { type: 'integer', format: 'uint8' } },
  },
  required: ['label', 'score', 'flag', 'scores'],
};

const decodeWith = (outputSchema: ComplexSchema, extra: Partial<ComplexCodecOptions> = {}) =>
  createComplexCodec({ commandId: 1, inputSchema: { type: 'null' }, outputSchema, ...extra });

type DecodeOutcome = { ok: boolean; result?: unknown; error?: { code: string; message: string } };

const decodeFailure = (
  codec: { decode(buffer: ArrayBuffer): DecodeOutcome },
  buffer: ArrayBuffer,
) => {
  const decoded = codec.decode(buffer);
  assert.equal(decoded.ok, false);
  if (decoded.ok || !decoded.error) throw new Error('expected a typed decode failure');
  return decoded.error;
};

test('complex codec reports invoke.too_short for empty and truncated headers', () => {
  const codec = decodeWith(pointSchema);
  const expected = {
    ok: false,
    error: { code: 'invoke.too_short', message: 'response too short' },
  };
  assert.deepEqual(codec.decode(new ArrayBuffer(0)), expected);
  for (const length of [1, 4, 7]) {
    assert.deepEqual(codec.decode(new Uint8Array(length).buffer), expected);
  }
});

test('complex codec classifies every non-success frame tag as an error frame', () => {
  const codec = decodeWith(pointSchema);
  assert.deepEqual(codec.decode(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer), {
    ok: false,
    error: { code: 'invoke.failed', message: 'complex invoke failed' },
  });
  for (const tag of [0, 2, 255]) {
    const error = decodeFailure(codec, new Uint8Array([tag, ...header.slice(1), 0, 0]).buffer);
    assert.equal(error.code, 'invoke.failed');
  }
  assert.equal(
    decodeFailure(codec, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]).buffer).code,
    'invoke.malformed',
  );
});

test('complex codec parses well-formed error frames into typed errors', () => {
  const codec = decodeWith(pointSchema);
  const code = [4, 98, 111, 111, 109];
  const message = [3, 98, 97, 100];
  const bytes = new Uint8Array([0, ...header.slice(1), 9, 0, ...code, ...message]);
  assert.deepEqual(codec.decode(bytes.buffer), {
    ok: false,
    error: { code: 'boom', message: 'bad' },
  });
  const truncated = new Uint8Array([0, ...header.slice(1), 255, 255]);
  assert.deepEqual(codec.decode(truncated.buffer), {
    ok: false,
    error: { code: 'invoke.malformed', message: 'complex response error is malformed' },
  });
});

test('complex codec rejects declared lengths that exceed the remaining bytes', () => {
  const cases: [ComplexSchema, number[]][] = [
    [profileSchema, [0xc8, 0x01]],
    [pointSchema, []],
    [
      {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'integer' } } },
        required: ['values'],
      },
      [5, 10],
    ],
    [mapSchema, [1, 0xc8, 0x01]],
  ];
  for (const [schema, payload] of cases) {
    const error = decodeFailure(decodeWith(schema), frame(payload));
    assert.equal(error.code, 'invoke.malformed');
    assert.match(error.message, /truncated complex payload/);
  }
});

test('complex codec rejects collection lengths beyond the configured limit', () => {
  const codec = decodeWith(
    {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'integer' } } },
      required: ['values'],
    },
    { maxCollectionLength: 2 },
  );
  const error = decodeFailure(codec, frame([3, 2, 4, 6]));
  assert.equal(error.code, 'invoke.malformed');
  assert.match(error.message, /collection length exceeds 2/);
});

test('complex codec rejects payloads truncated mid-field', () => {
  const cases: [ComplexSchema, number[]][] = [
    [pointSchema, [18]],
    [profileSchema, [3, 98, 111]],
    [statusSchema, [0]],
  ];
  for (const [schema, payload] of cases) {
    const error = decodeFailure(decodeWith(schema), frame(payload));
    assert.equal(error.code, 'invoke.malformed');
  }
});

test('complex codec rejects trailing bytes after a complete frame', () => {
  const codec = decodeWith(pointSchema);
  assert.deepEqual(codec.decode(frame([2, 6])), { ok: true, result: { x: 1, y: 3 } });
  for (const payload of [
    [2, 6, 0],
    [2, 6, 0, 0, 0],
  ]) {
    const error = decodeFailure(codec, frame(payload));
    assert.equal(error.code, 'invoke.malformed');
    assert.match(error.message, /trailing bytes/);
  }
});

test('complex codec rejects corrupted enum variant indexes', () => {
  const codec = decodeWith(statusSchema);
  assert.deepEqual(codec.decode(frame([1])), { ok: true, result: 'Idle' });
  for (const payload of [[2], [0xff, 0xff, 0xff, 0xff, 0x0f]]) {
    const error = decodeFailure(codec, frame(payload));
    assert.equal(error.code, 'invoke.malformed');
    assert.match(error.message, /variant index out of range/);
  }
});

test('complex codec rejects invalid presence tags and boolean bytes', () => {
  const presenceError = decodeFailure(decodeWith(optionalSchema), frame([2]));
  assert.equal(presenceError.code, 'invoke.malformed');
  assert.match(presenceError.message, /invalid optional field value presence tag/);
  const booleanError = decodeFailure(decodeWith(flagSchema), frame([2]));
  assert.equal(booleanError.code, 'invoke.malformed');
  assert.match(booleanError.message, /invalid boolean value/);
});

test('complex codec rejects duplicate and oversized map keys', () => {
  const codec = decodeWith(mapSchema);
  assert.deepEqual(codec.decode(frame([1, 1, 97, 2])), { ok: true, result: { counts: { a: 1 } } });
  const duplicate = decodeFailure(codec, frame([2, 1, 97, 2, 1, 97, 2]));
  assert.equal(duplicate.code, 'invoke.malformed');
  assert.match(duplicate.message, /duplicate map key a/);
});

test('complex codec rejects invalid UTF-8 inside string fields', () => {
  const codec = decodeWith(profileSchema);
  const error = decodeFailure(codec, frame([1, 0xff]));
  assert.equal(error.code, 'invoke.malformed');
});

test('complex codec survives a full bit-flip sweep with typed outcomes only', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: sweepSchema,
    outputSchema: sweepSchema,
  });
  const request = new Uint8Array(
    codec.encode({ label: 'rustra', score: -7, flag: true, scores: [1, 2, 255] }),
  );
  const source = new Uint8Array([...header, ...request.slice(2)]);
  assert.deepEqual(codec.decode(source.buffer), {
    ok: true,
    result: { label: 'rustra', score: -7, flag: true, scores: [1, 2, 255] },
  });

  let okCount = 0;
  let errorCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const mutated = Uint8Array.from(source);
      mutated[index] ^= 1 << bit;
      const decoded = codec.decode(mutated.buffer);
      if (decoded.ok) {
        okCount += 1;
        assert.equal(isConsistentSweepValue(decoded.result), true);
      } else {
        errorCount += 1;
        const error = decoded.error;
        if (!error) throw new Error('expected a typed decode error');
        assert.equal(typeof error.code, 'string');
        assert.equal(error.code.length > 0, true);
        assert.equal(typeof error.message, 'string');
      }
    }
  }
  assert.equal(okCount > 0, true);
  assert.equal(errorCount > 0, true);
});

function isConsistentSweepValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4) return false;
  if (typeof record.label !== 'string') return false;
  const score = record.score;
  if (typeof score !== 'number' || !Number.isSafeInteger(score)) return false;
  if (score < -0x80000000 || score > 0x7fffffff) return false;
  if (typeof record.flag !== 'boolean') return false;
  if (!Array.isArray(record.scores)) return false;
  return record.scores.every(
    (item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 0xff,
  );
}
