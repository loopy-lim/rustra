#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordBenchmarkEnvironment } from './benchmark-environment.mjs';

const devBenches = ['tier_compare', 'type_scaling', 'dynamic_registry'];
const releaseBenches = ['complex_route', 'tree_route', 'function_dispatch'];
const benches = [...devBenches, ...releaseBenches];

function git(repository, args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function validateComparisonRequest(repository, env = process.env) {
  const reference = env.COMPARISON_REF ?? '';
  if (!reference) return undefined;
  if (env.BOOTSTRAP_BASELINE === 'true') {
    throw new Error('Cannot combine comparison_ref with bootstrap_baseline=true.');
  }
  if (!/^[0-9a-fA-F]{40}$/.test(reference)) {
    throw new Error(
      'comparison_ref must be exactly 40 hexadecimal characters, an existing Git commit SHA.',
    );
  }
  const comparison = reference.toLowerCase();
  try {
    if (git(repository, ['cat-file', '-t', comparison]) !== 'commit')
      throw new Error('not a commit');
  } catch {
    throw new Error(
      'comparison_ref must identify an existing Git commit; use a full-history checkout.',
    );
  }
  const candidate = git(repository, ['rev-parse', 'HEAD']);
  try {
    if (comparison === candidate) throw new Error('same commit');
    git(repository, ['merge-base', '--is-ancestor', comparison, candidate]);
  } catch {
    throw new Error('comparison_ref must be a strict ancestor of the candidate HEAD.');
  }
  return { comparison, candidate };
}

function runCargo(repository, target, args, logPath, env) {
  console.log(`cargo ${args.join(' ')} (${repository})`);
  return new Promise((resolveRun, rejectRun) => {
    const log = createWriteStream(logPath);
    let outputError;
    log.on('error', (error) => {
      outputError = error;
      child.kill();
    });
    const child = spawn('cargo', args, {
      cwd: repository,
      env: { ...env, CARGO_TARGET_DIR: target, RUSTUP_TOOLCHAIN: '1.95.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    // close includes the final stdout/stderr chunks, unlike the exit event.
    child.on('close', (code, signal) => {
      log.end(() => {
        if (spawnError || outputError) rejectRun(spawnError ?? outputError);
        else if (code !== 0)
          rejectRun(
            new Error(
              `cargo ${args.join(' ')} exited with code ${code} (signal ${signal ?? 'none'}).`,
            ),
          );
        else resolveRun();
      });
    });
  });
}

async function hasBaseline(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = join(directory, entry.name);
      if (entry.name === 'base' && (await readdir(child)).includes('estimates.json')) return true;
      if (await hasBaseline(child)) return true;
    }
  }
  return false;
}

export async function prepareComparison(repository, request, env = process.env) {
  const temporaryRoot = env.RUNNER_TEMP ?? tmpdir();
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'rustra-benchmark-comparison-'));
  const oldRepository = join(directory, 'old-source');
  const oldTarget = join(directory, 'old-target');
  const candidateTarget = join(repository, 'target');
  const diagnostics = join(candidateTarget, 'criterion', 'comparison');
  await mkdir(diagnostics, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    comparisonSha: request.comparison,
    candidateSha: request.candidate,
    rustToolchain: '1.95.0',
    benches,
    stage: 'checkout',
    baselineInstalled: false,
  };
  const checkpoint = async (stage) => {
    receipt.stage = stage;
    await writeFile(join(diagnostics, 'comparison.json'), JSON.stringify(receipt, null, 2) + '\n');
  };
  let checkoutCreated = false;
  try {
    await checkpoint('checkout');
    git(repository, ['worktree', 'add', '--detach', oldRepository, request.comparison]);
    checkoutCreated = true;

    // Build both profiles of BOTH revisions before collecting any timing. A separate
    // target per revision prevents reuse of a candidate executable as the old baseline.
    for (const [revision, source, target] of [
      ['old', oldRepository, oldTarget],
      ['candidate', repository, candidateTarget],
    ]) {
      await checkpoint(`build-${revision}`);
      for (const [profile, group] of [
        ['dev', devBenches],
        ['release', releaseBenches],
      ]) {
        const args = [
          'bench',
          '-p',
          'rustra',
          ...(profile === 'dev' ? ['--profile', 'dev'] : []),
          '--no-run',
        ];
        for (const bench of group) args.push('--bench', bench);
        await runCargo(
          source,
          target,
          args,
          join(diagnostics, `build-${revision}-${profile}.log`),
          env,
        );
      }
    }

    for (const bench of benches) {
      await checkpoint(`measure-old-${bench}`);
      const args = [
        'bench',
        '-p',
        'rustra',
        ...(devBenches.includes(bench) ? ['--profile', 'dev'] : []),
        '--bench',
        bench,
      ];
      await runCargo(oldRepository, oldTarget, args, join(diagnostics, `old-${bench}.log`), env);
    }
    const oldCriterion = join(oldTarget, 'criterion');
    if (!(await hasBaseline(oldCriterion)))
      throw new Error('Old revision produced no Criterion baseline estimates.');
    await recordBenchmarkEnvironment(oldCriterion, { ...env, GITHUB_SHA: request.comparison });
    await checkpoint('install-baseline');
    // Partial old builds/measurements never enter the candidate Criterion tree.
    await cp(oldCriterion, join(candidateTarget, 'criterion'), { recursive: true });
    receipt.baselineInstalled = true;
    await checkpoint('ready-for-candidate-measurements');
    console.log(
      `Same-runner baseline ${request.comparison} is ready; candidate ${request.candidate} must pass the unchanged regression gate.`,
    );
    return receipt;
  } catch (error) {
    receipt.error = error.message;
    await checkpoint(`failed-${receipt.stage}`);
    throw error;
  } finally {
    if (checkoutCreated) git(repository, ['worktree', 'remove', '--force', oldRepository]);
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  try {
    const repository = process.cwd();
    const request = validateComparisonRequest(repository);
    if (request && !process.argv.includes('--validate-only'))
      await prepareComparison(repository, request);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
