import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectBenchmark, type BenchmarkMetadata } from '../apps/benchmark.js';
import { summarizeReceipts } from './benchmark-receipts.js';

async function fixtureReceipts() {
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
  const invoke = (command: string, bytes: Uint8Array) =>
    Uint8Array.from(command === 'gzipCompress' ? gzipSync(bytes) : gunzipSync(bytes));
  let time = 0;
  const base = await collectBenchmark(
    { json: invoke, bytes: invoke },
    {
      launchId: 'fixture',
      runtimeInstanceId: 'test',
      metadata,
      order: 'json-bytes',
      sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
      iterations: 20,
      warmup: 1,
      payloadSizes: [1024],
    },
    () => time++,
  );
  return Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(base),
    launchId: `fixture-${index}`,
    runtimeInstanceId: `fixture-runtime-${index}`,
    order: index % 2 === 0 ? ('json-bytes' as const) : ('bytes-json' as const),
  }));
}

test('five independent runtime receipts keep launch and order distributions separate', async () => {
  const summary = summarizeReceipts(await fixtureReceipts());
  assert.equal(summary.independentRuntimeReceipts, 5);
  assert.equal(summary.lanes.length, 2);
  assert.deepEqual(
    summary.lanes[0]!.byOrder.map((order) => order.launches),
    [3, 2],
  );
  assert.equal(summary.lanes[0]!.medianP50RatioJsonOverBytes, 1);
  assert.equal(summary.memory.status, 'not-instrumented');
});

test('incomplete, reused-runtime, non-crossover and mixed-device receipts are not comparable', async () => {
  const receipts = await fixtureReceipts();
  assert.throws(() => summarizeReceipts(receipts.slice(0, 4)), /five independent/);
  const duplicate = structuredClone(receipts);
  duplicate[1]!.runtimeInstanceId = duplicate[0]!.runtimeInstanceId;
  assert.throws(() => summarizeReceipts(duplicate), /duplicate/);
  const ordered = structuredClone(receipts);
  ordered[1]!.order = 'json-bytes';
  assert.throws(() => summarizeReceipts(ordered), /alternate/);
  const mixed = structuredClone(receipts);
  mixed[1]!.metadata.device = 'different';
  assert.throws(() => summarizeReceipts(mixed), /must match/);
});

test('corrupted raw samples, payload hashes and missing routes fail closed', async () => {
  const receipts = await fixtureReceipts();
  const samples = structuredClone(receipts);
  samples[0]!.lanes[0]!.samplesUs[0] = NaN;
  assert.throws(() => summarizeReceipts(samples), /samples/);
  const payload = structuredClone(receipts);
  payload[0]!.lanes[0]!.inputSha256 = 'a'.repeat(64);
  assert.throws(() => summarizeReceipts(payload), /both JSON and bytes/);
  const missing = structuredClone(receipts);
  missing[0]!.lanes.pop();
  assert.throws(() => summarizeReceipts(missing), /both JSON and bytes/);
});
