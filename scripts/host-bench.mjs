#!/usr/bin/env bun
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skipBuild = process.argv.includes('--skip-build');
const skipTauri = process.argv.includes('--skip-tauri');
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;

async function run(command, options = {}) {
  console.error(`\n$ ${command.join(' ')}`);
  const processHandle = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const stdout = await new Response(processHandle.stdout).text();
  const exitCode = await processHandle.exited;
  process.stdout.write(stdout);
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited ${exitCode}`);
  return stdout;
}

function parseReceipt(stdout) {
  const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith('RUSTRA_HOST_BENCH_JSON='));
  if (!marker) throw new Error('benchmark did not emit RUSTRA_HOST_BENCH_JSON');
  return JSON.parse(marker.slice('RUSTRA_HOST_BENCH_JSON='.length));
}

if (!skipBuild) {
  await run(['cargo', 'build', '--release', '-p', 'rustra-calculator-example', '--bins']);
  await run(['bun', 'run', '--cwd', 'examples/calculator-napi', 'build']);
  await run(['bun', 'run', 'build']);
  await run(['bunx', '--bun', 'tsc', '-p', 'examples/calculator/tsconfig.json']);
}

const receipts = [
  parseReceipt(await run(['node', 'dist-ts/examples/calculator/apps/node-performance.js'])),
  parseReceipt(await run(['bun', 'examples/calculator/apps/bun-performance.ts'])),
];
if (!skipTauri) {
  receipts.push(
    parseReceipt(
      await run(['bun', 'run', 'bench'], { cwd: resolve(root, 'examples/tauri-calculator') }),
    ),
  );
}

const nodeVersion = (await run(['node', '--version'])).trim();
const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    node: nodeVersion,
  },
  runtimeEvidence: receipts.map((entry) => entry.runtime),
  correctness: receipts.every((entry) =>
    entry.results.every(
      (result) =>
        result.correctness === true &&
        Number.isFinite(result.averageNs) &&
        result.averageNs > 0 &&
        result.normalization === 'trimmed-mean-5pct',
    ),
  ),
  results: receipts.flatMap((entry) => entry.results),
};

const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (output) await Bun.write(resolve(root, output), serialized);
console.log(`\nRUSTRA_HOST_MATRIX_JSON=${JSON.stringify(receipt)}`);
