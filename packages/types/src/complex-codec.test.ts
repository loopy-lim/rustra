import assert from 'node:assert/strict';
import test from 'node:test';
import { createComplexCodec } from './complex-codec.js';

const profileSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    score: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
  required: ['name', 'score', 'tags'],
};

const statusSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        Active: { type: 'object', properties: { level: { type: 'integer' } }, required: ['level'] },
      },
      required: ['Active'],
    },
    { type: 'string', enum: ['Idle'] },
  ],
};

const complexSchema = {
  type: 'object',
  properties: {
    profiles: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/Profile' },
    },
    maybeScores: {
      anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }],
    },
    status: statusSchema,
  },
  required: ['profiles', 'maybeScores', 'status'],
};

test('complex codec round-trips nested maps, options, sets, and data enums', () => {
  const codec = createComplexCodec({
    commandId: 7,
    inputSchema: complexSchema,
    outputSchema: complexSchema,
    definitions: { Profile: profileSchema },
  });
  const value = {
    profiles: {
      z: { name: 'Zed', score: -2, tags: new Set(['last', 'first']) },
      a: { name: '아', score: 42, tags: new Set(['한글']) },
    },
    maybeScores: [1, -2, 300],
    status: { Active: { level: 9 } },
  };

  const request = new Uint8Array(codec.encode(value));
  assert.deepEqual([...request.slice(0, 2)], [7, 0]);

  const response = new Uint8Array(8 + request.byteLength - 2);
  response[0] = 1;
  response.set(request.slice(2), 8);
  const decoded = codec.decode(response.buffer);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.result, {
    profiles: {
      a: { name: '아', score: 42, tags: new Set(['한글']) },
      z: { name: 'Zed', score: -2, tags: new Set(['first', 'last']) },
    },
    maybeScores: [1, -2, 300],
    status: { Active: { level: 9 } },
  });
});

test('complex codec rejects truncated frames and collection limit violations', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'integer' } } },
      required: ['values'],
    },
    outputSchema: { type: 'object', properties: {}, required: [] },
    maxCollectionLength: 2,
  });
  assert.throws(() => codec.encode({ values: [1, 2, 3] }), /collection length/);
  assert.deepEqual(codec.decode(new Uint8Array([1, 0, 1]).buffer).ok, false);
});

test('complex codec rejects invalid presence tags', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: [],
    },
  });
  const response = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.equal(codec.decode(response.buffer).ok, false);
});

test('complex codec rejects oneOf variants without stable keys', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    outputSchema: { type: 'null' },
  });
  assert.throws(() => codec.encode('value'), /stable key/);
});

test('complex codec accepts explicit keys for anonymous oneOf variants', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
      'x-rustra-variant-order': ['text', 'count'],
    },
    outputSchema: { type: 'null' },
  });
  assert.deepEqual(
    [...new Uint8Array(codec.encode('value'))],
    [1, 0, 1, 5, 118, 97, 108, 117, 101],
  );
});

test('complex codec validates integer ranges and preserves unsafe uint64 as bigint', () => {
  const codec = createComplexCodec({
    commandId: 4,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'integer', format: 'uint64' } },
      required: ['value'],
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'integer', format: 'uint64' } },
      required: ['value'],
    },
  });
  const value = 18_446_744_073_709_551_615n;
  assert.throws(() => codec.encode({ value: -1n }), /outside/);
  const request = new Uint8Array(codec.encode({ value }));
  const response = new Uint8Array(8 + request.byteLength - 2);
  response[0] = 1;
  response.set(request.slice(2), 8);
  const decoded = codec.decode(response.buffer);
  assert.deepEqual(decoded, { ok: true, result: { value } });
});

test('complex codec pins the Rust data-enum wire independently of oneOf order', () => {
  const codec = createComplexCodec({
    commandId: 1,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          oneOf: [
            { type: 'string', enum: ['idle'] },
            {
              type: 'object',
              properties: {
                active: {
                  type: 'object',
                  properties: { level: { type: 'integer', format: 'int64' } },
                  required: ['level'],
                },
              },
              required: ['active'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['status'],
    },
    outputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
  });
  assert.deepEqual(
    [...new Uint8Array(codec.encode({ status: { active: { level: 7 } } }))],
    [1, 0, 0, 14],
  );
  const response = new Uint8Array([
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    8,
    ...new TextEncoder().encode('active:7'),
  ]);
  assert.deepEqual(codec.decode(response.buffer), { ok: true, result: { label: 'active:7' } });
});
