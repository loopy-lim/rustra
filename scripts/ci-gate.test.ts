import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import test from 'node:test';

// gate 잡이 실제로 호출하는 스크립트를 spawn한다 — 로직 복제 없이 계약을 검증한다.
// node --experimental-strip-types --test 로 실행한다(test:release-tools 와 동일
// 스타일 — bun:test 가 아닌 node:test 를 쓴다).
const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), 'ci-gate.sh');
const ciYmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/ci.yml');

// .github/workflows/ci.yml gate 잡의 needs 순서와 정확히 일치해야 한다.
const MANDATORY_JOBS = [
  'changes',
  'rust',
  'rust-msrv',
  'rust-wasm32',
  'rust-audit',
  'rust-deny',
  'napi',
  'typescript',
  'rn-android',
  'rn-ios',
  'uniffi-android',
  'uniffi-ios',
  'consumer-smoke',
] as const;

// 경로 필터 skip 이 허용되는 모바일 잡 — ci.yml 의 if 조건이 붙은 잡과 정확히
// 일치해야 한다(ci-gate.sh 의 filter_skippable_jobs 도 동일 목록).
const FILTER_SKIPPABLE_JOBS = ['rn-android', 'rn-ios', 'uniffi-android', 'uniffi-ios'] as const;

interface GateContext {
  /** github.event_name — 미설정 시 env 에서도 제거한다(fail-safe 경로 검증용). */
  eventName?: string;
  /** changes 잡의 code 출력 — 미설정 시 env 에서도 제거한다. */
  changesCode?: string;
}

function runGate(
  results: Partial<Record<(typeof MANDATORY_JOBS)[number], string>>,
  context: GateContext = {},
) {
  const args = MANDATORY_JOBS.map((job) => {
    const value = results[job];
    assert.ok(value, `test bug: missing result for ${job}`);
    return `${job}=${value}`;
  });
  const env: Record<string, string | undefined> = { ...process.env };
  // 컨텍스트를 항상 결정적으로 만든다 — 셸에 남아 있는 GATE_* 를 지운다.
  delete env.GATE_EVENT_NAME;
  delete env.GATE_CHANGES_CODE;
  if (context.eventName !== undefined) env.GATE_EVENT_NAME = context.eventName;
  if (context.changesCode !== undefined) env.GATE_CHANGES_CODE = context.changesCode;
  return spawnSync('bash', [gatePath, ...args], { encoding: 'utf8', env });
}

const success: Record<string, string> = Object.fromEntries(
  MANDATORY_JOBS.map((job) => [job, 'success']),
);

test('all thirteen jobs success exits 0 with a green summary', () => {
  const r = runGate(success);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gate: PASS/);
  // 통과 요약은 13개 잡을 전부 나열한다 — 사람이 매트릭스를 눈으로 대조하지 않게.
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

test('docs-only PR: filter-skipped mobile jobs pass the gate', () => {
  // pull_request + changes.code=false — 경로 필터가 건너뛴 설계된 skip 이다.
  // GitHub 은 필수 체크의 skipped 를 merge 요건 충족으로 보므로 gate 도 인정한다.
  const results: Partial<Record<(typeof MANDATORY_JOBS)[number], string>> = { ...success };
  for (const job of FILTER_SKIPPABLE_JOBS) results[job] = 'skipped';
  const r = runGate(results, { eventName: 'pull_request', changesCode: 'false' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gate: PASS/);
  for (const job of FILTER_SKIPPABLE_JOBS) {
    assert.match(r.stdout, new RegExp(`skip ${job}`), `summary must mark ${job} as filter-skipped`);
  }
});

test('genuine skip fails even under the filter allowance (chain skip is not covered)', () => {
  // 모바일 잡은 필터 skip 이 인정돼도 consumer-smoke 의 체인 skip 은 여전히 red.
  const results: Partial<Record<(typeof MANDATORY_JOBS)[number], string>> = {
    ...success,
    'consumer-smoke': 'skipped',
  };
  results['rn-android'] = 'skipped';
  const r = runGate(results, { eventName: 'pull_request', changesCode: 'false' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /consumer-smoke/);
  // 허용된 모바일 skip 은 범인으로 보고하지 않는다.
  assert.ok(!r.stderr.includes('rn-android'), 'allowed filter skip must not be reported');
});

test('mobile skip fails on non-pull_request events (filter never skips push)', () => {
  const r = runGate(
    { ...success, 'rn-ios': 'skipped' },
    { eventName: 'push', changesCode: 'true' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rn-ios/);
});

test('mobile skip fails when the path filter says code changed', () => {
  // code=true 면 모바일 잡이 실행됐어야 한다 — skip 은 조용한 green 위험이다.
  const r = runGate(
    { ...success, 'uniffi-android': 'skipped' },
    { eventName: 'pull_request', changesCode: 'true' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uniffi-android/);
});

test('missing gate context env is fail-safe: skips are never allowed', () => {
  // 구식 호출자(env 미전달)는 모든 skip 을 실패로 본다.
  const r = runGate({ ...success, 'rn-ios': 'skipped' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rn-ios/);
});

test('changes job failure fails the gate', () => {
  // 경로 필터 잡 자체의 실패(예: API 오류)는 조용히 흡수되면 안 된다.
  const r = runGate({ ...success, changes: 'failure' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /changes/);
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
  assert.match(r.stderr, /exactly 13/);
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
    [
      gatePath,
      ...MANDATORY_JOBS.slice(0, 12).map((j) => `${j}=success`),
      'nonexistent-job=success',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nonexistent-job/);
});

test('duplicate job argument is a hard error even when all results are success', () => {
  // 13개 인자가 중복을 포함하면(consumer-smoke 대신 rust 2회) 한 잡이 검사되지
  // 않은 채 PASS 로 빠진다 — 전부 success 여도 계약 위반이다.
  const r = spawnSync(
    'bash',
    [
      gatePath,
      ...MANDATORY_JOBS.slice(0, 12).map((j) => `${j}=success`), // consumer-smoke 누락
      'rust=success', // rust 중복
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

test('path-filtered mobile jobs in ci.yml match FILTER_SKIPPABLE_JOBS', () => {
  // ci.yml 의 모바일 4잡이 changes 에 의존하고 경로 필터 if 조건을 갖는지 —
  // 스크립트의 skip 허용 목록과 워크플로가 갈라지면 즉시 드러낸다.
  const doc = parse(readFileSync(ciYmlPath, 'utf8'));
  const mobileJobs = Object.keys(doc.jobs).filter(
    (name) => !['changes', 'gate'].includes(name) && doc.jobs[name].needs?.includes('changes'),
  );
  assert.deepEqual(mobileJobs.sort(), [...FILTER_SKIPPABLE_JOBS].sort());
  for (const job of FILTER_SKIPPABLE_JOBS) {
    const cond: string = doc.jobs[job].if;
    assert.match(
      cond,
      /needs\.changes\.outputs\.code == 'true'/,
      `${job} must gate on the changes.code output`,
    );
  }
});
