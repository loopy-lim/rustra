import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  percentile,
  pseudoRandomPayload,
  validateMetadata,
  type BenchmarkReceipt,
  type BenchmarkLane,
} from '../apps/benchmark.js';

function laneKey(lane: BenchmarkLane): string {
  return `${lane.command}:${lane.inputBytes}:${lane.inputSha256}`;
}

/** Fail closed on incomplete/cross-environment reports; do not pool per-call samples across launches. */
export function summarizeReceipts(receipts: BenchmarkReceipt[]) {
  if (receipts.length < 5) throw new Error('at least five independent app launches are required');
  const launches = new Set<string>();
  const runtimes = new Set<string>();
  const cohort = JSON.stringify(receipts[0]!.metadata);
  let laneKeys: string[] | undefined;
  const comparisons: Array<{
    launchId: string;
    order: string;
    lanes: Map<string, { json: BenchmarkLane; bytes: BenchmarkLane }>;
  }> = [];
  for (const [index, receipt] of receipts.entries()) {
    validateMetadata(receipt.metadata);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.evidence !== 'react-native-runtime' ||
      receipt.correctness !== 'all-outputs-byte-equal' ||
      receipt.timing !== 'individual-call-including-js-adapter'
    ) {
      throw new Error('unsupported or unsuccessful benchmark receipt');
    }
    if (JSON.stringify(receipt.metadata) !== cohort)
      throw new Error(
        'source, bundle, native binary, runtime and device must match across launches',
      );
    if (
      !receipt.launchId ||
      launches.has(receipt.launchId) ||
      !receipt.runtimeInstanceId ||
      runtimes.has(receipt.runtimeInstanceId)
    ) {
      throw new Error('duplicate or missing app launch/runtime identity');
    }
    launches.add(receipt.launchId);
    runtimes.add(receipt.runtimeInstanceId);
    if (
      !['json-bytes', 'bytes-json'].includes(receipt.order) ||
      (index > 0 && receipt.order === receipts[index - 1]!.order)
    ) {
      throw new Error('launch order must alternate json-bytes / bytes-json');
    }
    if (
      !Number.isInteger(receipt.iterations) ||
      receipt.iterations < 20 ||
      !Number.isInteger(receipt.warmup) ||
      receipt.warmup < 1
    ) {
      throw new Error('insufficient warmup or individual-call samples');
    }
    if (receipt.iterations !== receipts[0]!.iterations || receipt.warmup !== receipts[0]!.warmup)
      throw new Error('sampling configuration differs across launches');
    const pairs = new Map<string, Partial<Record<'json' | 'bytes', BenchmarkLane>>>();
    for (const lane of receipt.lanes) {
      if (
        !['json', 'bytes'].includes(lane.route) ||
        !['gzipCompress', 'gzipDecompress'].includes(lane.command)
      )
        throw new Error('unexpected lane');
      if (
        !Number.isInteger(lane.inputBytes) ||
        lane.inputBytes < 1 ||
        !Number.isInteger(lane.outputBytes) ||
        lane.outputBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(lane.inputSha256) ||
        !/^[a-f0-9]{64}$/.test(lane.outputSha256)
      )
        throw new Error('missing payload size or SHA-256');
      if (
        lane.samplesUs.length !== receipt.iterations ||
        lane.samplesUs.some((sample) => sample <= 0) ||
        percentile(lane.samplesUs, 0.5) !== lane.p50Us ||
        percentile(lane.samplesUs, 0.95) !== lane.p95Us
      )
        throw new Error('invalid raw samples or percentile summary');
      const key = laneKey(lane);
      const pair = pairs.get(key) ?? {};
      if (pair[lane.route]) throw new Error('duplicate benchmark lane');
      pair[lane.route] = lane;
      pairs.set(key, pair);
    }
    const complete = new Map<string, { json: BenchmarkLane; bytes: BenchmarkLane }>();
    for (const [key, pair] of pairs) {
      if (!pair.json || !pair.bytes)
        throw new Error('each operation must have both JSON and bytes routes');
      if (
        pair.json.outputBytes !== pair.bytes.outputBytes ||
        pair.json.outputSha256 !== pair.bytes.outputSha256
      )
        throw new Error('JSON and bytes outputs differ');
      complete.set(key, { json: pair.json, bytes: pair.bytes });
    }
    const compressions = [...complete.values()].filter(
      (pair) => pair.json.command === 'gzipCompress',
    );
    if (compressions.length === 0 || complete.size !== compressions.length * 2)
      throw new Error('compression and decompression pairs required');
    for (const { json: lane } of compressions) {
      if (lane.inputBytes > 256 * 1024)
        throw new Error('payload exceeds the benchmark input limit');
      const expectedHash = createHash('sha256')
        .update(pseudoRandomPayload(lane.inputBytes))
        .digest('hex');
      if (expectedHash !== lane.inputSha256)
        throw new Error('payload does not match the deterministic benchmark fixture');
      const inverse = complete.get(`gzipDecompress:${lane.outputBytes}:${lane.outputSha256}`)?.json;
      if (
        !inverse ||
        inverse.outputBytes !== lane.inputBytes ||
        inverse.outputSha256 !== lane.inputSha256
      )
        throw new Error('gzip round-trip provenance mismatch');
    }
    const keys = [...complete.keys()].sort();
    if (laneKeys && JSON.stringify(keys) !== JSON.stringify(laneKeys))
      throw new Error('payload lanes differ across launches');
    laneKeys = keys;
    comparisons.push({ launchId: receipt.launchId, order: receipt.order, lanes: complete });
  }
  return {
    schemaVersion: 1,
    evidence: 'react-native-runtime',
    metadata: receipts[0]!.metadata,
    independentRuntimeReceipts: receipts.length,
    // Runtime identities prevent reusing one collector. The platform driver still proves process restarts.
    nativeProcessRestarts: 'verify-in-platform-driver-log',
    decision: 'measurement-only',
    memory: { allocationBytes: null, nativeCopiedBytes: null, status: 'not-instrumented' },
    lanes: laneKeys!.map((key) => {
      const launches = comparisons.map((comparison) => {
        const pair = comparison.lanes.get(key)!;
        return {
          launchId: comparison.launchId,
          order: comparison.order,
          jsonP50Us: pair.json.p50Us,
          bytesP50Us: pair.bytes.p50Us,
          jsonP95Us: pair.json.p95Us,
          bytesP95Us: pair.bytes.p95Us,
          p50RatioJsonOverBytes: pair.json.p50Us / pair.bytes.p50Us,
          p95RatioJsonOverBytes: pair.json.p95Us / pair.bytes.p95Us,
        };
      });
      const first = comparisons[0]!.lanes.get(key)!.json;
      return {
        command: first.command,
        inputBytes: first.inputBytes,
        inputSha256: first.inputSha256,
        outputBytes: first.outputBytes,
        outputSha256: first.outputSha256,
        launches,
        medianP50RatioJsonOverBytes: percentile(
          launches.map((launch) => launch.p50RatioJsonOverBytes),
          0.5,
        ),
        byOrder: ['json-bytes', 'bytes-json'].map((order) => {
          const subset = launches.filter((launch) => launch.order === order);
          return {
            order,
            launches: subset.length,
            medianP50RatioJsonOverBytes: percentile(
              subset.map((launch) => launch.p50RatioJsonOverBytes),
              0.5,
            ),
          };
        }),
      };
    }),
  };
}

function main() {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length < 5)
    throw new Error(
      'Usage: bun scripts/benchmark-receipts.ts <summary.json> <launch-1.json> ... <launch-5.json>',
    );
  if (inputs.some((input) => resolve(input) === resolve(output)))
    throw new Error('summary must not overwrite a raw launch receipt');
  const receipts = inputs.map(
    (input) => JSON.parse(readFileSync(input, 'utf8')) as BenchmarkReceipt,
  );
  const summary = summarizeReceipts(receipts);
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(`summarized ${receipts.length} independent runtime receipts into ${output}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
