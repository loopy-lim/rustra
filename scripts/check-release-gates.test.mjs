import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditReleaseGates, evaluateRuns } from './check-release-gates.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = 'rustra/rustra';

test('crate propagation waits for the registry even when a matching workspace package exists', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  for (const [step, crate] of [
    ['Wait for rustra-naming index propagation', 'rustra-naming'],
    ['Wait for crates.io index propagation', 'rustra-macros'],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'rustra-index-wait-'));
    try {
      // Without an explicit registry Cargo resolves the matching local package
      // immediately. The registry only exposes the version on the second poll.
      for (const [name, source] of Object.entries({
        cargo: `#!/bin/sh
if [ "$1" = metadata ]; then echo '{}'; exit 0; fi
printf '%s\\n' "$*" >> "$POLL_LOG"
case " $* " in
  *' --registry crates-io '*)
    if [ -f "$REGISTRY_READY" ]; then exit 0; fi
    touch "$REGISTRY_READY"
    exit 101 ;;
  *) echo 'version: 0.12.0 (from ./crates/local-workspace)'; exit 0 ;;
esac
`,
        jq: '#!/bin/sh\ncat >/dev/null\necho 0.12.0\n',
        sleep: '#!/bin/sh\nexit 0\n',
      })) {
        writeFileSync(join(root, name), source);
        chmodSync(join(root, name), 0o755);
      }
      const section = workflow.split(`      - name: ${step}\n`)[1]?.split('\n      - name:')[0];
      assert.ok(section, `missing propagation step: ${step}`);
      const script = section.split('        run: |\n')[1].replace(/^          /gm, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          POLL_LOG: join(root, 'polls.log'),
          REGISTRY_READY: join(root, 'ready'),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const polls = readFileSync(join(root, 'polls.log'), 'utf8').trim().split('\n');
      assert.equal(polls.length, 2, `${crate} must wait past the unavailable registry version`);
      for (const poll of polls) {
        assert.match(poll, new RegExp(`^info ${crate}@0\\.12\\.0 `));
        assert.match(poll, /--registry crates-io(?: |$)/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

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
