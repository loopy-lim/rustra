import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { test } from 'bun:test';

// gate 잡이 실제로 호출하는 스크립트를 spawn한다 — 로직 복제 없이 계약을 검증한다.
const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), 'ci-gate.sh');
const ciYmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/ci.yml');

// .github/workflows/ci.yml gate 잡의 needs 순서와 정확히 일치해야 한다.
const MANDATORY_JOBS = [
  'rust',
  'rust-msrv',
  'rust-wasm32',
  'rust-audit',
  'rust-deny',
  'napi',
  'typescript',
  'rn-android',
  'rn-ios',
  'consumer-smoke',
] as const;

function runGate(results: Partial<Record<(typeof MANDATORY_JOBS)[number], string>>) {
  const args = MANDATORY_JOBS.map((job) => {
    const value = results[job];
    assert.ok(value, `test bug: missing result for ${job}`);
    return `${job}=${value}`;
  });
  return spawnSync('bash', [gatePath, ...args], { encoding: 'utf8' });
}

const success: Record<string, string> = Object.fromEntries(
  MANDATORY_JOBS.map((job) => [job, 'success']),
);

test('all ten jobs success exits 0 with a green summary', () => {
  const r = runGate(success);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gate: PASS/);
  // 통과 요약은 10개 잡을 전부 나열한다 — 사람이 매트릭스를 눈으로 대조하지 않게.
  for (const job of MANDATORY_JOBS) {
    assert.ok(r.stdout.includes(job), `summary must list ${job}`);
  }
});

test('a single failure exits nonzero and names the offending job', () => {
  const r = runGate({ ...success, typescript: 'failure' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /typescript/);
  assert.match(r.stderr, /failure/);
});

test('skipped is treated as failure (consumer-smoke skip chain preserved)', () => {
  // typescript 실패 → consumer-smoke 스킵 체인을 게이트가 놓치면 안 된다.
  const r = runGate({ ...success, 'consumer-smoke': 'skipped' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /consumer-smoke/);
  assert.match(r.stderr, /skipped/);
});

test('cancelled is treated as failure', () => {
  const r = runGate({ ...success, 'rn-ios': 'cancelled' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rn-ios/);
  assert.match(r.stderr, /cancelled/);
});

test('mixed failure/skipped names every offending job', () => {
  const r = runGate({
    ...success,
    rust: 'failure',
    'rust-deny': 'skipped',
    'consumer-smoke': 'skipped',
  });
  assert.notEqual(r.status, 0);
  for (const job of ['rust', 'rust-deny', 'consumer-smoke']) {
    assert.match(r.stderr, new RegExp(job));
  }
  // 정상 잡은 흠집 내지 않는다 — 범인만 stderr에.
  assert.ok(!r.stderr.includes('rust-msrv'), 'healthy jobs must not be reported');
});

test('multiple failures each appear once in the report', () => {
  const r = runGate({ ...success, 'rn-android': 'failure', 'rn-ios': 'failure' });
  assert.notEqual(r.status, 0);
  const rnAndroidCount = r.stderr.split('rn-android').length - 1;
  const rnIosCount = r.stderr.split('rn-ios').length - 1;
  assert.equal(rnAndroidCount, 1, 'rn-android must appear exactly once');
  assert.equal(rnIosCount, 1, 'rn-ios must appear exactly once');
});

test('an unknown result value fails loudly instead of passing silently', () => {
  const r = runGate({ ...success, napi: 'weird' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /napi/);
  assert.match(r.stderr, /weird/);
});

test('wrong argument count is a hard error, not a pass', () => {
  const r = spawnSync('bash', [gatePath, 'rust=success'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exactly 10/);
});

test('malformed argument (no = separator) is a hard error', () => {
  const r = spawnSync('bash', [gatePath, ...MANDATORY_JOBS.map((j) => `${j}success`)], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rust=success/); // 올바른 형태 예시를 보여준다
});

test('unknown job name is a hard error, not a silent pass', () => {
  // 워크플로와 스크립트의 잡 목록이 갈라지면(잡 개명 등) 조용한 green 이 아니라
  // 즉시 드러나야 한다.
  const r = spawnSync(
    'bash',
    [gatePath, ...MANDATORY_JOBS.slice(0, 9).map((j) => `${j}=success`), 'nonexistent-job=success'],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nonexistent-job/);
});

test('duplicate job argument is a hard error even when all results are success', () => {
  // 10개 인자가 중복을 포함하면(consumer-smoke 대신 rust 2회) 한 잡이 검사되지
  // 않은 채 PASS 로 빠진다 — 전부 success 여도 계약 위반이다.
  const r = spawnSync(
    'bash',
    [
      gatePath,
      'rust=success',
      ...MANDATORY_JOBS.slice(1, 9).map((j) => `${j}=success`),
      'rust=success', // consumer-smoke 누락, rust 중복
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate/);
});

test('workflow gate needs list matches MANDATORY_JOBS in name and order', () => {
  // 조용한 커버리지 갈라짐 차단 — gate needs 에 새 잡이 추가돼도 스크립트 인자가
  // 없으면 그 잡은 검사 없이 통과한다(반대 방향도 마찬가지). 이 테스트가 갈라짐을
  // 즉시 loud failure 로 만든다.
  const doc = parse(readFileSync(ciYmlPath, 'utf8'));
  const needs = doc.jobs.gate.needs;
  assert.deepEqual(needs, [...MANDATORY_JOBS]);
});
