import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

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

test('artifact names use valid with context and only successful jobs become baselines', () => {
  const upload = workflow.split('      - name: Upload criterion artifacts')[1];
  assert.ok(upload, 'the benchmark must preserve its artifact upload step');
  assert.match(upload, /if:\s*always\(\)/, 'failed and cancelled runs keep diagnostic artifacts');
  const name = /^\s+name:\s*([^\n]+)$/m.exec(upload)?.[1];
  const parts = /^([^$]+)\$\{\{(.+)\}\}$/.exec(name ?? '');
  assert.ok(parts, 'the artifact name must include its status-dependent suffix');
  const [, prefix, expression] = parts;
  // GitHub permits the job context in steps.with, but status-check functions only in if.
  assert.doesNotMatch(
    expression,
    /\b(?:always|success|failure|cancelled)\s*\(/,
    'status-check functions in with.name prevent the workflow from being parsed',
  );
  for (const status of ['success', 'failure', 'cancelled']) {
    // This expression uses the shared JS/Actions subset: string comparison and &&/||.
    const suffix = runInNewContext(expression, { job: { status } }, { timeout: 100 });
    assert.equal(
      `${prefix}${suffix}`,
      status === 'success' ? 'criterion-results' : 'criterion-results-rejected',
      `${status} must not change benchmark baseline eligibility`,
    );
  }
});

test('branching tree route uses the optimized profile and is included in reports', () => {
  assert.match(workflow, /cargo bench -p rustra --bench tree_route/);
  assert.match(workflow, /bench_tree\.txt/);
});

test('benchmark gate preserves inconclusive/regression exit codes', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const block = workflow
    .split('      - name: Enforce 10% regression budget')[1]
    .split('\n      - name:')[0];
  const script = block
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.replace(/^          /, ''))
    .join('\n');
  const root = await mkdtemp(join(tmpdir(), 'rustra-bench-workflow-'));
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/bun'), '#!/bin/sh\nexit "$BENCH_EXIT"\n', { mode: 0o755 });
    for (const code of [0, 1, 2, 3]) {
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          BENCH_EXIT: String(code),
          GITHUB_OUTPUT: join(root, 'output'),
        },
      });
      assert.equal(result.status, code, `gate changed exit ${code}: ${result.stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every Cargo-registered benchmark is invoked by CI', async () => {
  const cargo = await readFile(new URL('../crates/rustra/Cargo.toml', import.meta.url), 'utf8');
  const benches = [...cargo.matchAll(/\[\[bench\]\]\s*name\s*=\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(benches.length > 0);
  for (const name of benches) assert.match(workflow, new RegExp(`--bench ${name}\\b`), name);
});

test('failed baseline restoration cannot reuse cached Criterion results', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  assert.ok(
    workflow.indexOf('name: Reset cached Criterion artifacts') <
      workflow.indexOf('name: Restore previous baseline'),
  );
  assert.ok(
    workflow.indexOf('name: Restore previous baseline') <
      workflow.indexOf('name: Record benchmark environment'),
  );
  assert.ok(
    workflow.indexOf('name: Record benchmark environment') <
      workflow.indexOf('name: Run tier_compare benchmark'),
  );
  assert.match(workflow, /bun scripts\/benchmark-environment\.mjs target\/criterion/);
  const stepScript = (name) => {
    const block = workflow.split(`      - name: ${name}`)[1]?.split('\n      - name:')[0];
    if (!block) return '';
    const run = block.split('        run: ')[1];
    return run.startsWith('|\n')
      ? run
          .slice(2)
          .split('\n')
          .map((line) => line.replace(/^          /, ''))
          .join('\n')
      : run.trim();
  };
  const root = await mkdtemp(join(tmpdir(), 'rustra-bench-cache-'));
  try {
    await mkdir(join(root, 'target/criterion/old/base'), { recursive: true });
    await writeFile(join(root, 'target/criterion/old/base/estimates.json'), '{}');
    await writeFile(join(root, 'target/build-cache-sentinel'), 'keep');
    // No artifact is restored between reset and requirement checking.
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-c',
        stepScript('Reset cached Criterion artifacts') +
          '\n' +
          stepScript('Require a real previous baseline'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, 'a stale cache was accepted as a restored baseline');
    assert.match(result.stderr, /No previous Criterion baseline/);
    assert.equal(await readFile(join(root, 'target/build-cache-sentinel'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const comparisonHelper = fileURLToPath(new URL('./benchmark-comparison.mjs', import.meta.url));
const comparisonBenches = [
  'tier_compare',
  'type_scaling',
  'dynamic_registry',
  'complex_route',
  'tree_route',
  'function_dispatch',
];

async function withComparisonFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'rustra-bench-comparison-'));
  const repo = join(root, 'repository');
  const bin = join(root, 'bin');
  const callLog = join(root, 'cargo-calls.jsonl');
  await mkdir(repo);
  await mkdir(bin);
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Benchmark Test', '-c', 'user.email=bench@example.test', ...args],
      {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  try {
    git('init');
    await writeFile(join(repo, 'revision'), 'old');
    git('add', 'revision');
    git('commit', '-m', 'old benchmark');
    const old = git('rev-parse', 'HEAD');
    const sibling = git('commit-tree', 'HEAD^{tree}', '-p', old, '-m', 'unrelated candidate');
    await writeFile(join(repo, 'revision'), 'candidate');
    git('commit', '-am', 'candidate benchmark');
    const candidate = git('rev-parse', 'HEAD');

    // Git/process/filesystem orchestration is real. Only the expensive Cargo boundary
    // is a fixture executable: it exposes build order, revision, output and failures.
    await writeFile(
      join(bin, 'cargo'),
      String.raw`#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('cargo 1.95.0 (fixture)'); process.exit(0); }
const revision = readFileSync('revision', 'utf8');
const build = args.includes('--no-run');
const benches = args.flatMap((arg, index) => arg === '--bench' ? [args[index + 1]] : []);
appendFileSync(process.env.BENCH_CALL_LOG, JSON.stringify({ args, revision, build, benches,
  target: process.env.CARGO_TARGET_DIR, toolchain: process.env.RUSTUP_TOOLCHAIN }) + '\n');
if (build && process.env.BENCH_FAIL === 'build-' + revision) process.exit(17);
if (!build) {
  for (const bench of benches) {
    if (process.env.BENCH_FAIL === 'measure-' + bench) process.exit(19);
    for (const kind of ['base', 'new']) {
      const directory = join(process.env.CARGO_TARGET_DIR, 'criterion', bench, 'case', kind);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'estimates.json'), JSON.stringify({ mean: {
        point_estimate: 100, confidence_interval: { lower_bound: 99, upper_bound: 101 }
      }}));
    }
    console.log('measurement-tail ' + revision + ' ' + bench);
  }
}
`,
      { mode: 0o755 },
    );
    for (const tool of ['rustc', 'bun']) {
      await writeFile(join(bin, tool), `#!/bin/sh\necho '${tool} fixture'\n`, { mode: 0o755 });
    }
    const invoke = (overrides = {}, args = []) =>
      spawnSync(process.execPath, [comparisonHelper, ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: join(root, 'temporary'),
          COMPARISON_REF: old,
          BOOTSTRAP_BASELINE: 'false',
          BENCH_CALL_LOG: callLog,
          ...overrides,
        },
      });
    const calls = async () => {
      try {
        return (await readFile(callLog, 'utf8')).trim().split('\n').map(JSON.parse);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    };
    const baselineFiles = async () => {
      const found = [];
      const visit = async (directory) => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.name === 'estimates.json' && directory.endsWith('/base')) found.push(path);
        }
      };
      await visit(join(repo, 'target', 'criterion'));
      return found;
    };
    await run({ repo, old, sibling, candidate, invoke, calls, baselineFiles });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('manual same-runner comparison does not alter normal baseline restoration or gate eligibility', () => {
  assert.match(workflow, /comparison_ref:\s*\n[\s\S]*?type: string/);
  assert.match(workflow, /fetch-depth: 0/);
  const step = (name) => workflow.split(`      - name: ${name}`)[1]?.split('\n      - name:')[0];
  const restore = step('Restore previous baseline');
  const comparison = step('Build both revisions and measure comparison baseline');
  const validation = step('Validate benchmark comparison request');
  assert.ok(comparison, 'manual comparisons need their own preparation stage');
  assert.ok(validation, 'untrusted comparison refs must be validated before Cargo runs');
  assert.match(validation, /COMPARISON_REF:\s*\$\{\{ inputs\.comparison_ref/);
  assert.doesNotMatch(
    validation.split('        run:')[1],
    /\$\{\{/,
    'input must enter via env, not shell code',
  );
  for (const [event, ref, normal, compare] of [
    ['push', '', true, false],
    ['workflow_dispatch', '', true, false],
    ['workflow_dispatch', 'a'.repeat(40), false, true],
  ]) {
    const context = { github: { event_name: event }, inputs: { comparison_ref: ref } };
    const evaluate = (block) =>
      runInNewContext(/^\s+if:\s*(.+)$/m.exec(block)?.[1] ?? '', context, { timeout: 100 });
    assert.equal(evaluate(restore), normal);
    assert.equal(evaluate(comparison), compare);
  }
  assert.ok(
    workflow.indexOf('name: Build both revisions') <
      workflow.indexOf('name: Record benchmark environment'),
  );
  assert.match(workflow, /--max-regression 0\.10 --report bench-report\.md/);
});

test('comparison refs fail closed before Cargo for malformed, unknown, non-ancestor and self commits', async () => {
  await withComparisonFixture(async ({ old, sibling, candidate, invoke, calls, baselineFiles }) => {
    for (const [ref, message] of [
      ['main', /40 hexadecimal/],
      ['a'.repeat(40) + '; echo injected', /40 hexadecimal/],
      ['0'.repeat(40), /existing Git commit/],
      [sibling, /strict ancestor/],
      [candidate, /strict ancestor/],
    ]) {
      const result = invoke({ COMPARISON_REF: ref }, ['--validate-only']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message, ref);
    }
    const bootstrap = invoke({ COMPARISON_REF: old, BOOTSTRAP_BASELINE: 'true' });
    assert.notEqual(bootstrap.status, 0);
    assert.match(bootstrap.stderr, /cannot combine.*bootstrap/i);
    assert.deepEqual(await calls(), [], 'validation must precede all Cargo work');
    assert.deepEqual(await baselineFiles(), [], 'invalid comparisons must not install a baseline');
  });
});

test('comparison prebuilds both revisions and all six benches before any measurement, then installs the old baseline', async () => {
  await withComparisonFixture(async ({ repo, old, invoke, calls, baselineFiles }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const operations = await calls();
    const firstMeasurement = operations.findIndex((operation) => !operation.build);
    assert.ok(firstMeasurement > 0);
    const builds = operations.slice(0, firstMeasurement);
    for (const revision of ['old', 'candidate']) {
      assert.deepEqual(
        builds
          .filter((operation) => operation.revision === revision)
          .flatMap((operation) => operation.benches)
          .sort(),
        [...comparisonBenches].sort(),
        `${revision} must finish building every bench before old measurements`,
      );
    }
    assert.ok(
      operations
        .slice(firstMeasurement)
        .every((operation) => !operation.build && operation.revision === 'old'),
    );
    assert.deepEqual(
      operations.slice(firstMeasurement).flatMap((operation) => operation.benches),
      comparisonBenches,
    );
    assert.ok(operations.every((operation) => operation.toolchain === '1.95.0'));
    assert.equal(
      new Set(
        operations
          .filter((operation) => operation.revision === 'old')
          .map((operation) => operation.target),
      ).size,
      1,
    );
    assert.equal(
      new Set(
        operations
          .filter((operation) => operation.revision === 'candidate')
          .map((operation) => operation.target),
      ).size,
      1,
    );
    assert.notEqual(
      builds.find((operation) => operation.revision === 'old').target,
      builds.find((operation) => operation.revision === 'candidate').target,
    );
    assert.equal((await baselineFiles()).length, 6);
    const environment = JSON.parse(
      await readFile(join(repo, 'target/criterion/runner-environment.json'), 'utf8'),
    );
    assert.equal(environment.workflow.GITHUB_SHA, old);
    const log = await readFile(
      join(repo, 'target/criterion/comparison/old-function_dispatch.log'),
      'utf8',
    );
    assert.match(log, /measurement-tail old function_dispatch/);
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(
      (worktrees.match(/^worktree /gm) ?? []).length,
      1,
      'temporary old checkout must be cleaned up',
    );
  });
});

test('either revision build failure prevents measurement and baseline installation', async () => {
  for (const revision of ['old', 'candidate']) {
    await withComparisonFixture(async ({ invoke, calls, baselineFiles }) => {
      const result = invoke({ BENCH_FAIL: `build-${revision}` });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cargo.*(?:exit|code).*17/i);
      assert.ok((await calls()).every((operation) => operation.build));
      assert.deepEqual(await baselineFiles(), []);
    });
  }
});

test('partial old measurements are diagnostic data, never an installed candidate baseline', async () => {
  await withComparisonFixture(async ({ repo, invoke, calls, baselineFiles }) => {
    const result = invoke({ BENCH_FAIL: 'measure-complex_route' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cargo.*(?:exit|code).*19/i);
    assert.ok(
      (await calls()).some(
        (operation) => !operation.build && operation.benches.includes('tier_compare'),
      ),
    );
    assert.deepEqual(
      await baselineFiles(),
      [],
      'partial old results must not become candidate baseline data',
    );
    assert.match(
      await readFile(join(repo, 'target/criterion/comparison/old-tier_compare.log'), 'utf8'),
      /measurement-tail/,
    );
  });
});
