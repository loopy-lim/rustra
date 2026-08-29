import { createComplexCodec } from '../packages/types/src/index.ts';

const profileSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    score: { type: 'integer', format: 'int64' },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
  required: ['name', 'score', 'tags'],
};

const schema = {
  type: 'object',
  properties: {
    profiles: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/Profile' },
    },
    maybeScores: {
      anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }],
    },
    status: {
      oneOf: [
        { type: 'string', enum: ['idle'] },
        {
          type: 'object',
          properties: {
            active: {
              type: 'object',
              properties: { level: { type: 'integer' } },
              required: ['level'],
            },
          },
          required: ['active'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['profiles', 'maybeScores', 'status'],
};

const sample = {
  profiles: {
    z: { name: 'Zed', score: -2, tags: new Set(['first', 'last']) },
    아: { name: '아', score: 42, tags: new Set(['한글']) },
  },
  maybeScores: [1, -2, 300],
  status: { active: { level: 9 } },
};

function numericOption(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function runComplexCodecBench(options = {}) {
  const iterations = numericOption(options.iterations, 20_000);
  const warmup = numericOption(options.warmup, 1_000);
  const codec = createComplexCodec({
    commandId: 7,
    inputSchema: schema,
    outputSchema: schema,
    definitions: { Profile: profileSchema },
  });

  for (let i = 0; i < warmup; i += 1) {
    const request = codec.encode(sample);
    const body = new Uint8Array(request).slice(2);
    const response = new Uint8Array(8 + body.length);
    response[0] = 1;
    response.set(body, 8);
    codec.decode(response.buffer);
  }

  let requestBytes = 0;
  let responseBytes = 0;
  const encodeStart = performance.now();
  const requests = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const request = codec.encode(sample);
    requests[i] = request;
    requestBytes = request.byteLength;
  }
  const encodeUs = ((performance.now() - encodeStart) * 1_000) / iterations;

  const decodeStart = performance.now();
  for (const request of requests) {
    const body = new Uint8Array(request).slice(2);
    const response = new Uint8Array(8 + body.length);
    response[0] = 1;
    response.set(body, 8);
    responseBytes = response.byteLength;
    const result = codec.decode(response.buffer);
    if (!result.ok) throw new Error(`complex codec benchmark decode failed: ${result.error.message}`);
  }
  const decodeUs = ((performance.now() - decodeStart) * 1_000) / iterations;

  return {
    schema: 'nested-map-option-set-data-enum',
    route: 'complex-binary-js',
    iterations,
    requestBytes,
    responseBytes,
    encodeUs: Number(encodeUs.toFixed(3)),
    decodeUs: Number(decodeUs.toFixed(3)),
    allocationMode: 'per-call-writer-and-response',
    verified: true,
    limitations: ['does not measure Rust or C++ native dispatch', 'single-process wall-clock sample'],
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(runComplexCodecBench()));
}
