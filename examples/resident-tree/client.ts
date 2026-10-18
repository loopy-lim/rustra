import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { configure, createNodeEngine, createNodeLoopTransport } from '@rustra/node';
import {
  loadTree,
  findNode,
  findWholeTree,
  updateNode,
  releaseTree,
  clearTrees,
} from './generated/commands.js';
import { GENERATED_CONTRACT_HASH } from './generated/contract.js';
import type { Node } from './generated/types.js';

const executable = process.env.RUSTRA_RESIDENT_BINARY;
if (!executable)
  throw new Error('Run test:app:resident-tree to build and select the native executable');
const transport = createNodeLoopTransport({ command: executable });
configure(createNodeEngine(transport));
const tree: Node = {
  id: 0,
  value: 0,
  children: Array.from({ length: 1024 }, (_, i) => ({ id: i + 1, value: i + 1, children: [] })),
};
try {
  assert.equal(await transport.invoke('__rustra_contract', {}), GENERATED_CONTRACT_HASH);
  const started = performance.now();
  let handle = await loadTree({ tree });
  const loadMs = performance.now() - started;
  const residentUs: number[] = [],
    wholeUs: number[] = [];
  for (let i = 0; i < 100; i++) {
    // Alternating order avoids giving either route every first position.
    for (const route of i % 2 ? ['whole', 'resident'] : ['resident', 'whole']) {
      const start = performance.now();
      const found =
        route === 'resident'
          ? await findNode({ handle, target: 1024 })
          : await findWholeTree({ tree, target: 1024 });
      (route === 'resident' ? residentUs : wholeUs).push((performance.now() - start) * 1000);
      assert.equal(found.value, 1024);
    }
  }
  const old = handle;
  handle = await updateNode({ handle, target: 1024, value: -7 });
  await assert.rejects(findNode({ handle: old, target: 1024 }), /stale/i);
  assert.equal((await findNode({ handle, target: 1024 })).value, -7);
  await releaseTree(handle);
  await assert.rejects(findNode({ handle, target: 1024 }), /stale/i);
  const loaded = await loadTree({ tree });
  await clearTrees({});
  const reloaded = await loadTree({ tree });
  assert.notEqual(loaded.id, reloaded.id);
  await assert.rejects(findNode({ handle: loaded, target: 1024 }), /stale/i);
  await releaseTree(reloaded);
  const summarize = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    };
  };
  const resident = summarize(residentUs),
    whole = summarize(wholeUs);
  const savedUs = whole.mean - resident.mean;
  const receipt = {
    schemaVersion: 1,
    profile: 'debug',
    transport: 'persistent NDJSON',
    nodes: 1025,
    loadMs,
    residentUs,
    wholeUs,
    summaryUs: { resident, whole },
    breakEvenQueries: savedUs > 0 ? Math.ceil((loadMs * 1000) / savedUs) : null,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    requestBytes: {
      whole: Buffer.byteLength(JSON.stringify({ tree, target: 1024 })),
      resident: Buffer.byteLength(JSON.stringify({ handle, target: 1024 })),
    },
    contractHash: GENERATED_CONTRACT_HASH,
    lifecycle: 'load/update/stale/release/clear pass',
  };
  writeFileSync(new URL('receipt.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    `resident-tree: lifecycle PASS; ${receipt.requestBytes.whole} → ${receipt.requestBytes.resident} request bytes; load ${loadMs.toFixed(2)} ms`,
  );
} finally {
  transport.dispose();
}
