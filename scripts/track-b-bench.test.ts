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

test('committed receipt matches the script output shape — no hand-edited receipts', async () => {
  // 재발 방지(2026-08-29): receipt 를 스크립트 밖에서 손으로 편집한 적이
  // 있다. 커밋된 receipt 가 스크립트 스키마와 내부 정합성을 유지하는지 검증
  // — 타이밍 수치 자체가 아니라 "스크립트 산출물의 모양"을 검사하므로 기계
  // 속도와 무관하게 통과/실패가 결정된다.
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(
    new URL('../docs/benchmark-receipts/2026-08-29-track-b.json', import.meta.url),
    'utf8',
  );
  const receipt = JSON.parse(raw);
  assert.equal(receipt.command, 'bun scripts/track-b-bench.mjs');
  assert.equal(receipt.runs, 'median of 3 executions');
  assert.ok(Array.isArray(receipt.results) && receipt.results.length === 4);
  assert.ok(
    typeof receipt.allRunsUs === 'object' && Object.keys(receipt.allRunsUs).length === 4,
    'all 3 runs per op must be recorded',
  );
  for (const row of receipt.results) {
    const runs = receipt.allRunsUs[`${row.op}:${row.schema}`];
    assert.ok(Array.isArray(runs) && runs.length === 3);
    const sorted = [...runs].sort((a, b) => a - b);
    assert.equal(
      row.us,
      sorted[1],
      `committed receipt median must be real for ${row.op}:${row.schema}`,
    );
  }
});
