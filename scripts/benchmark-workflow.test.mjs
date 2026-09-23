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
