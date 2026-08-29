import assert from 'node:assert/strict';
import test from 'node:test';
import { runTrackBBench } from './track-b-bench.mjs';

test('track B benchmark emits a bounded machine-readable receipt', () => {
  const receipt = runTrackBBench({ iterations: 25, warmup: 5 });
  assert.equal(receipt.route, 'complex-binary-js');
  assert.equal(receipt.results.length, 4);
  for (const row of receipt.results) {
    assert.ok(row.iterations === 25);
    assert.ok(row.bytes > 0);
    assert.ok(row.us >= 0);
  }
  assert.equal(receipt.verified, true);
});

test('reported median is the actual median of the recorded runs', () => {
  const receipt = runTrackBBench({ iterations: 25, warmup: 5 });
  assert.equal(receipt.runs, 'median of 3 executions');
  const opKeys = Object.keys(receipt.allRunsUs);
  assert.equal(opKeys.length, 4);
  for (const row of receipt.results) {
    const runs = receipt.allRunsUs[`${row.op}:${row.schema}`];
    assert.ok(
      Array.isArray(runs) && runs.length === 3,
      `3 runs recorded for ${row.op}:${row.schema}`,
    );
    assert.ok(runs.includes(row.us), `reported us ${row.us} is one of the recorded runs`);
    const sorted = [...runs].sort((a, b) => a - b);
    assert.equal(row.us, sorted[1], `reported us is the true median for ${row.op}:${row.schema}`);
  }
});
