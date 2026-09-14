import assert from 'node:assert/strict';
import test from 'node:test';

import { auditReleaseGates, evaluateRuns } from './check-release-gates.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = 'rustra/rustra';

function run(overrides = {}) {
  return {
    id: 100,
    run_attempt: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: SHA,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-14T00:00:00Z',
    run_started_at: '2026-09-14T00:00:01Z',
    updated_at: '2026-09-14T00:01:00Z',
    html_url: 'https://github.com/rustra/rustra/actions/runs/100',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    actor: { login: 'fixture-user' },
    ...overrides,
  };
}

test('evaluateRuns accepts the newest successful attempt for the exact source', () => {
  const result = evaluateRuns(
    [
      run({ id: 100, run_attempt: 1, conclusion: 'failure' }),
      run({ id: 100, run_attempt: 2, created_at: '2026-09-14T00:05:00Z' }),
    ],
    { sha: SHA, workflow: 'ci.yml', repository: REPOSITORY },
  );

  assert.equal(result.ok, true);
  assert.equal(result.run.id, 100);
  assert.equal(result.run.run_attempt, 2);
});

test('evaluateRuns fails closed for missing or mismatched source runs', () => {
  const cases = [
    ['missing', []],
    ['different SHA', [run({ head_sha: 'f'.repeat(40) })]],
    ['different workflow', [run({ path: '.github/workflows/release.yml' })]],
    ['different repository', [run({ repository: { full_name: 'fork/rustra' } })]],
    ['different head repository', [run({ head_repository: { full_name: 'fork/rustra' } })]],
  ];

  for (const [label, runs] of cases) {
    const result = evaluateRuns(runs, {
      sha: SHA,
      workflow: 'ci.yml',
      repository: REPOSITORY,
    });
    assert.equal(result.ok, false, label);
  }
});

test('evaluateRuns rejects schedule CI and non-success terminal states', () => {
  for (const [label, overrides] of [
    ['schedule', { event: 'schedule' }],
    ['failure', { conclusion: 'failure' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['skipped', { conclusion: 'skipped' }],
    ['queued', { status: 'queued', conclusion: null }],
  ]) {
    const result = evaluateRuns([run(overrides)], {
      sha: SHA,
      workflow: 'ci.yml',
      repository: REPOSITORY,
    });
    assert.equal(result.ok, false, label);
  }
});

test('evaluateRuns ignores schedule CI when selecting the newest eligible push or PR', () => {
  const result = evaluateRuns(
    [
      run({ id: 100, created_at: '2026-09-14T00:00:00Z' }),
      run({ id: 101, event: 'schedule', created_at: '2026-09-14T00:10:00Z' }),
    ],
    { sha: SHA, workflow: 'ci.yml', repository: REPOSITORY },
  );

  assert.equal(result.ok, true);
  assert.equal(result.run.id, 100);
});

test('evaluateRuns accepts standalone and called safety workflow events', () => {
  for (const event of ['schedule', 'workflow_dispatch', 'workflow_call']) {
    const result = evaluateRuns(
      [run({ name: 'Miri', path: '.github/workflows/miri.yml', event })],
      { sha: SHA, workflow: 'miri.yml', repository: REPOSITORY },
    );
    assert.equal(result.ok, true, event);
  }
});

test('evaluateRuns rejects a success without a valid run attempt', () => {
  const result = evaluateRuns([run({ run_attempt: 0 })], {
    sha: SHA,
    workflow: 'ci.yml',
    repository: REPOSITORY,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /run_attempt/);
});

test('evaluateRuns does not let an older success hide the newest failure', () => {
  const result = evaluateRuns(
    [
      run({ id: 99, created_at: '2026-09-14T00:00:00Z' }),
      run({ id: 101, created_at: '2026-09-14T00:10:00Z', conclusion: 'failure' }),
    ],
    { sha: SHA, workflow: 'ci.yml', repository: REPOSITORY },
  );

  assert.equal(result.ok, false);
  assert.equal(result.run.id, 101);
});

test('evaluateRuns uses current attempt activity so a rerun failure cannot hide behind a newer-created success', () => {
  for (const [status, conclusion] of [
    ['completed', 'failure'],
    ['queued', null],
  ]) {
    const result = evaluateRuns(
      [
        run({
          id: 90,
          run_attempt: 2,
          created_at: '2026-09-14T00:00:00Z',
          run_started_at: '2026-09-14T00:20:00Z',
          updated_at: '2026-09-14T00:20:01Z',
          status,
          conclusion,
        }),
        run({
          id: 100,
          run_attempt: 1,
          created_at: '2026-09-14T00:10:00Z',
          run_started_at: '2026-09-14T00:10:01Z',
          updated_at: '2026-09-14T00:11:00Z',
        }),
      ],
      { sha: SHA, workflow: 'ci.yml', repository: REPOSITORY },
    );

    assert.equal(result.ok, false, status);
    assert.equal(result.run.id, 90, status);
    assert.equal(result.run.run_attempt, 2, status);
  }
});

test('auditReleaseGates paginates and emits an exact-source receipt', async () => {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(
      JSON.stringify({
        workflow_runs:
          page === 1
            ? Array.from({ length: 100 }, (_, index) =>
                run({ id: 1000 + index, head_sha: 'a'.repeat(40) }),
              )
            : page === 2
              ? [run()]
              : [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const receipt = await auditReleaseGates({
    repository: REPOSITORY,
    sha: SHA,
    workflows: ['ci.yml'],
    fetchImpl,
    token: 'fixture-token',
    now: () => new Date('2026-09-14T01:00:00Z'),
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.repository, REPOSITORY);
  assert.equal(receipt.sha, SHA);
  assert.equal(receipt.checked_at, '2026-09-14T01:00:00.000Z');
  assert.equal(receipt.gates[0].run.run_attempt, 1);
  assert.deepEqual(Object.keys(receipt.gates[0].run).sort(), [
    'conclusion',
    'created_at',
    'event',
    'head_sha',
    'html_url',
    'id',
    'name',
    'path',
    'repository',
    'run_attempt',
    'run_started_at',
    'status',
    'updated_at',
  ]);
  assert.equal(requested.length, 2);
  assert.match(String(requested[0].url), /per_page=100&page=1/);
  assert.match(String(requested[1].url), /per_page=100&page=2/);
  assert.equal(requested[0].init.signal instanceof AbortSignal, true);
});
