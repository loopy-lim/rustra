import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordBenchmarkEnvironment } from './benchmark-environment.mjs';
import { execFileSync } from 'node:child_process';
import { benchmarkArtifact, collectBenchmarkSource } from './host-benchmark-provenance.mjs';

test('host receipts identify dirty sources and exact artifacts, including missing libraries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-host-provenance-'));
  try {
    await mkdir(join(root, 'packages', 'fixture', 'src'), { recursive: true });
    const source = join(root, 'packages', 'fixture', 'src', 'index.ts');
    await writeFile(source, 'export const value = 1;');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: root },
    );
    const before = collectBenchmarkSource(root);
    assert.equal(before.sourceDirty, false);
    await writeFile(source, 'export const value = 2;');
    const after = collectBenchmarkSource(root);
    assert.equal(after.sourceSha, before.sourceSha);
    assert.equal(after.sourceDirty, true);
    assert.notEqual(after.sourceTreeHash, before.sourceTreeHash);
    assert.equal(benchmarkArtifact(root, 'missing.dylib'), null);
    await writeFile(join(root, 'native.dylib'), 'candidate-one');
    const first = benchmarkArtifact(root, 'native.dylib');
    await writeFile(join(root, 'native.dylib'), 'candidate-two');
    assert.notEqual(benchmarkArtifact(root, 'native.dylib').sha256, first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner provenance preserves the restored context and never changes Criterion data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-bench-context-'));
  const previous = '{"runId":"previous-run"}\n';
  try {
    await writeFile(join(root, 'runner-environment.json'), previous);
    await mkdir(join(root, 'case/base'), { recursive: true });
    await writeFile(join(root, 'case/base/estimates.json'), '{"unchanged":true}');
    const result = await recordBenchmarkEnvironment(root, {
      GITHUB_RUN_ID: '123',
      GITHUB_SHA: 'candidate-sha',
      RUSTFLAGS: '--cfg benchmark_secret',
      UNRELATED_SECRET: 'do-not-record-me',
    });
    assert.equal(await readFile(join(root, 'restored-runner-environment.json'), 'utf8'), previous);
    assert.equal(
      await readFile(join(root, 'case/base/estimates.json'), 'utf8'),
      '{"unchanged":true}',
    );
    const output = await readFile(join(root, 'runner-environment.json'), 'utf8');
    assert.doesNotMatch(output, /do-not-record-me|benchmark_secret/);
    assert.equal(result.workflow.GITHUB_RUN_ID, '123');
    assert.equal(result.workflow.GITHUB_SHA, 'candidate-sha');
    assert.match(result.configurationDigests.RUSTFLAGS, /^[0-9a-f]{64}$/);
    assert.match(result.tools.rustc, /^rustc /);
    assert.match(result.tools.cargo, /^cargo /);
    assert.equal(typeof result.host.logicalCpuCount, 'number');
    assert.ok(Array.isArray(result.host.cpuModels));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy artifact without context is recorded as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustra-bench-legacy-'));
  try {
    await writeFile(join(root, 'restored-runner-environment.json'), 'stale ancestor');
    const result = await recordBenchmarkEnvironment(root, {});
    assert.equal(result.restoredEnvironmentAvailable, false);
    assert.equal(result.workflow.GITHUB_SHA, null);
    await assert.rejects(readFile(join(root, 'restored-runner-environment.json')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
