import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/bench.yml', import.meta.url), 'utf8');

test('benchmark workflow measures every registered core Criterion route', () => {
  for (const bench of ['tier_compare', 'type_scaling', 'dynamic_registry']) {
    assert.match(
      workflow,
      new RegExp(`cargo bench -p rustra --profile dev --bench ${bench}`),
      `${bench} must run in the benchmark workflow`,
    );
  }
  assert.match(
    workflow,
    /cargo bench -p rustra --bench complex_route/,
    'the static complex route must use the production-equivalent release profile',
  );
});

test('benchmark summary includes the complex route log', () => {
  assert.match(workflow, /bench_complex\.txt/);
});
