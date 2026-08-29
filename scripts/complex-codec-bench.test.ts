import assert from 'node:assert/strict';
import test from 'node:test';
import { runComplexCodecBench } from './complex-codec-bench.mjs';

test('complex benchmark emits a bounded machine-readable receipt', () => {
  const receipt = runComplexCodecBench({ iterations: 25, warmup: 5 });
  assert.equal(receipt.route, 'complex-binary-js');
  assert.equal(receipt.schema, 'nested-map-option-set-data-enum');
  assert.equal(receipt.iterations, 25);
  assert.ok(receipt.requestBytes > 2);
  assert.ok(receipt.responseBytes > 8);
  assert.ok(receipt.encodeUs >= 0);
  assert.ok(receipt.decodeUs >= 0);
  assert.equal(receipt.verified, true);
});
