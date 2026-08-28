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
