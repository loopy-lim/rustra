import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  asBytes,
  collectBenchmark,
  percentile,
  type BenchmarkMetadata,
  type BenchmarkTransport,
} from './benchmark.js';

const metadata: BenchmarkMetadata = {
  platform: 'ios',
  target: 'simulator',
  device: 'test-fixture',
  osVersion: 'test',
  runtime: 'hermes',
  runtimeVersion: 'test',
  reactNativeVersion: 'test',
  buildMode: 'release',
  sourceRevision: '1'.repeat(40),
  sourceSha256: '2'.repeat(64),
  bundleSha256: '3'.repeat(64),
  nativeSha256: '4'.repeat(64),
  contractHash: '5'.repeat(64),
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const options = {
  launchId: 'fixture-1',
  runtimeInstanceId: 'test-runtime',
  metadata,
  order: 'json-bytes' as const,
  sha256,
  iterations: 20,
  warmup: 1,
  payloadSizes: [1024],
};
const transform: BenchmarkTransport['bytes'] = (command, input) =>
  Uint8Array.from(command === 'gzipCompress' ? gzipSync(input) : gunzipSync(input));

test('same gzip operations and identical inputs cross both routes, with individual-call percentiles', async () => {
  let ticks = 0;
  const seen: Array<{ route: string; command: string; hash: string }> = [];
  const route =
    (name: string): BenchmarkTransport['bytes'] =>
    (command, input) => {
      seen.push({ route: name, command, hash: sha256(input) });
      return transform(command, input);
    };
  const receipt = await collectBenchmark(
    { json: route('json'), bytes: route('bytes') },
    options,
    () => ticks++,
  );
  assert.equal(receipt.lanes.length, 4);
  assert.deepEqual(
    receipt.lanes.map((lane) => [lane.command, lane.route]),
    [
      ['gzipCompress', 'json'],
      ['gzipCompress', 'bytes'],
      ['gzipDecompress', 'json'],
      ['gzipDecompress', 'bytes'],
    ],
  );
  for (const command of ['gzipCompress', 'gzipDecompress']) {
    assert.equal(
      new Set(seen.filter((call) => call.command === command).map((call) => call.hash)).size,
      1,
    );
  }
  assert.ok(
    receipt.lanes.every(
      (lane) => lane.samplesUs.length === 20 && lane.p50Us === 1000 && lane.p95Us === 1000,
    ),
  );
  assert.deepEqual(receipt.memory, {
    allocationBytes: null,
    nativeCopiedBytes: null,
    status: 'not-instrumented',
  });
});

test('wrong bytes, mutated input, or invalid hashes fail instead of producing a success receipt', async () => {
  await assert.rejects(
    collectBenchmark({ json: transform, bytes: () => new Uint8Array([0]) }, options),
    /gzip bytes mismatch/,
  );
  await assert.rejects(
    collectBenchmark(
      { json: transform, bytes: transform },
      { ...options, sha256: () => 'unknown' },
    ),
    /payload SHA-256/,
  );
  const mutating: BenchmarkTransport['bytes'] = async (command, input) => {
    const output = await transform(command, input);
    if (command === 'gzipCompress') input[0] ^= 1;
    return output;
  };
  await assert.rejects(
    collectBenchmark(
      { json: transform, bytes: mutating },
      { ...options, warmup: 1, iterations: 20 },
    ),
    /mismatch|mutated/,
  );
});

test('crossover reverses route order and validates native measurement metadata', async () => {
  const receipt = await collectBenchmark(
    { json: transform, bytes: transform },
    { ...options, order: 'bytes-json' },
  );
  assert.deepEqual(
    receipt.lanes.map((lane) => lane.route),
    ['bytes', 'json', 'bytes', 'json'],
  );
  await assert.rejects(
    collectBenchmark(
      { json: transform, bytes: transform },
      { ...options, metadata: { ...metadata, nativeSha256: '' } },
    ),
    /nativeSha256/,
  );
  await assert.rejects(
    collectBenchmark({ json: transform, bytes: transform }, { ...options, iterations: 0 }),
    /iterations/,
  );
  await assert.rejects(
    collectBenchmark(
      { json: transform, bytes: transform },
      { ...options, payloadSizes: [1024 * 1024] },
    ),
    /payload sizes/,
  );
});

test('byte conversion rejects coercion and nearest-rank percentile retains raw sample meaning', () => {
  assert.throws(() => asBytes([-1]), /must contain bytes/);
  assert.throws(() => asBytes([256]), /must contain bytes/);
  assert.throws(() => asBytes(['1']), /must contain bytes/);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, index) => index + 1),
      0.95,
    ),
    95,
  );
  assert.throws(() => percentile([NaN], 0.5), /finite/);
});
