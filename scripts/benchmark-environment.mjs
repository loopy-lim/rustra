#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

// Record diagnostic provenance, not an automatic baseline acceptance policy.
// Explicitly select public CI fields; never serialize the process environment.
export async function recordBenchmarkEnvironment(criterionRoot, env = process.env) {
  await mkdir(criterionRoot, { recursive: true });
  const output = join(criterionRoot, 'runner-environment.json');
  const restored = join(criterionRoot, 'restored-runner-environment.json');
  let restoredEnvironmentAvailable = true;
  try {
    await copyFile(output, restored);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    restoredEnvironmentAvailable = false;
    await rm(restored, { force: true });
  }

  const processors = cpus();
  const workflowKeys = [
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'RUNNER_ENVIRONMENT',
    'ImageOS',
    'ImageVersion',
  ];
  const flagKeys = ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'CARGO_BUILD_TARGET'];
  const result = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    restoredEnvironmentAvailable,
    workflow: Object.fromEntries(workflowKeys.map((key) => [key, env[key] ?? null])),
    host: {
      platform: platform(),
      architecture: arch(),
      kernelRelease: release(),
      cpuModels: [...new Set(processors.map((cpu) => cpu.model))].sort(),
      logicalCpuCount: processors.length,
      availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem(),
    },
    tools: {
      rustc: execFileSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' }).trim(),
      cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
      bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
    },
    configurationDigests: Object.fromEntries(
      flagKeys.map((key) => [
        key,
        env[key] === undefined ? null : createHash('sha256').update(env[key]).digest('hex'),
      ]),
    ),
  };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? 'target/criterion');
  await recordBenchmarkEnvironment(root);
  console.log(`Benchmark environment recorded in ${join(root, 'runner-environment.json')}`);
}
