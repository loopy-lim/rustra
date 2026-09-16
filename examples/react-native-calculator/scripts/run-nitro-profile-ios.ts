#!/usr/bin/env bun
/** One dedicated-app CPU profile. Profiled throughput never replaces parity measurements. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROFILE_CONTRACT, parseProfileURL } from '../src/nitro-parity/profile';
import { GENERATED_CONTRACT_HASH } from '../generated/contract';
import { computeBuildFingerprint } from './generate-build-fingerprint.mjs';
import { requireDedicatedApp } from './parity-app-policy';
import { validateProfileWindow } from './profile-window';

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    output: { type: 'string' },
    case: { type: 'string' },
    framework: { type: 'string' },
    'embedded-run': { type: 'string' },
    'bundle-id': { type: 'string', default: 'com.rustra.nitroparity' },
  },
});
if (!values.device || !values.output || !values.case || !values.framework)
  throw Error('--device, --output, --case and --framework required');
const bundle = values['bundle-id']!;
requireDedicatedApp(bundle);
const device = values.device;
const runId = values['embedded-run'] ?? `profile-${Date.now()}`;
const url = `rustra-parity://profile?case=${encodeURIComponent(values.case)}&framework=${values.framework}&run=${runId}&ms=15000`;
const plan = parseProfileURL(url);
const output = resolve(values.output);
await mkdir(output, { recursive: false });
const commands: unknown[] = [];
function command(args: string[], allowFailure = false) {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  commands.push({ args, status: result.exitCode, stdout, stderr });
  if (result.exitCode !== 0 && !allowFailure) throw Error(`${args[0]} failed: ${stderr}`);
  return stdout;
}
const simctl = (args: string[], allowFailure = false) =>
  command(['xcrun', 'simctl', ...args], allowFailure);
const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const app = simctl(['get_app_container', device, bundle, 'app']);
const data = simctl(['get_app_container', device, bundle, 'data']);
const executable = command([
  '/usr/libexec/PlistBuddy',
  '-c',
  'Print CFBundleExecutable',
  join(app, 'Info.plist'),
]);
const binaryPath = join(app, executable);
const identity = {
  binarySha256: await sha(binaryPath),
  bundleSha256: await sha(join(app, 'main.jsbundle')),
  infoPlistSha256: await sha(join(app, 'Info.plist')),
};
const { fingerprint } = await computeBuildFingerprint();
const receiptPath = join(data, 'Documents', 'rustra-benchmark-receipt.json');
async function receipt() {
  try {
    return JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT' || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}
function matches(value: Record<string, unknown>) {
  return (
    value.contract === PROFILE_CONTRACT &&
    value.runId === runId &&
    value.caseId === plan.caseId &&
    value.framework === plan.framework &&
    value.durationMs === plan.durationMs &&
    value.fingerprint === fingerprint &&
    value.generatedContract === GENERATED_CONTRACT_HASH
  );
}
let sampler: ReturnType<typeof Bun.spawn> | undefined;
try {
  simctl(['terminate', device, bundle], true);
  const previous = await readFile(receiptPath).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous) await writeFile(join(output, 'previous-receipt.json'), previous);
  await unlink(receiptPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const launchAt = new Date().toISOString();
  // Launch first; the app installs its URL-event listener before the host sends the plan.
  const launch = simctl(['launch', device, bundle]);
  const pid = Number(launch.match(/:\s*(\d+)\s*$/)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error(`cannot identify dedicated process: ${launch}`);
  const processCommand = command(['ps', '-p', String(pid), '-o', 'comm=']);
  if (processCommand !== binaryPath)
    throw Error(`dedicated executable path mismatch: ${processCommand}`);
  const deadline = Date.now() + 60000;
  let active: Record<string, unknown> | undefined;
  let urlSent = false;
  while (Date.now() < deadline) {
    const current = await receipt();
    if (current?.status === 'awaiting-url') {
      if (values['embedded-run']) throw Error('embedded profile plan missing from bundle');
      if (
        current.contract !== PROFILE_CONTRACT ||
        current.fingerprint !== fingerprint ||
        current.generatedContract !== GENERATED_CONTRACT_HASH
      )
        throw Error('URL handshake identity mismatch');
      if (!urlSent) {
        await writeFile(join(output, 'awaiting-url.json'), JSON.stringify(current, null, 2));
        simctl(['openurl', device, url]);
        urlSent = true;
      }
      await Bun.sleep(50);
      continue;
    }
    if (current?.status === 'complete')
      await writeFile(join(output, 'complete-raw.json'), JSON.stringify(current, null, 2));
    if (current && !matches(current)) throw Error('profile phase identity mismatch');
    if (current?.status === 'active') {
      active = current;
      break;
    }
    if (current?.status === 'complete')
      throw Error('active window was missed; do not sample idle app');
    await Bun.sleep(50);
  }
  if (!active) throw Error('profile never entered active phase');
  await writeFile(join(output, 'active.json'), JSON.stringify(active, null, 2));
  const sampleArgs = [
    '/usr/bin/sample',
    String(pid),
    '10',
    '1',
    '-file',
    join(output, 'sample.txt'),
  ];
  const sampleStartedAt = new Date().toISOString();
  console.log(`Profiling ${plan.caseId} ${plan.framework}, dedicated PID ${pid}`);
  sampler = Bun.spawn(sampleArgs, {
    stdout: Bun.file(join(output, 'sample.stdout')),
    stderr: Bun.file(join(output, 'sample.stderr')),
  });
  const sampleExitCode = await sampler.exited;
  const sampleFinishedAt = new Date().toISOString();
  if (sampleExitCode !== 0) throw Error(`sample failed ${sampleExitCode}; raw outputs retained`);
  let complete: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const current = await receipt();
    // Preserve native output even when its identity or capture window is rejected.
    if (current?.status === 'complete')
      await writeFile(join(output, 'complete-raw.json'), JSON.stringify(current, null, 2));
    if (current && !matches(current)) throw Error('profile completion identity mismatch');
    if (current?.status === 'complete') {
      complete = current;
      break;
    }
    await Bun.sleep(100);
  }
  if (
    !complete ||
    complete.runtime !== 'Hermes' ||
    complete.release !== true ||
    complete.platform !== 'ios' ||
    complete.environment !== 'simulator' ||
    complete.nitroVersion !== '0.37.1' ||
    complete.nitrogenVersion !== '0.37.1'
  )
    throw Error('invalid or missing completed profile');
  const iterations = Number(complete.iterations),
    expected = Number(complete.expectedPerCall),
    checksum = Number(complete.checksum);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations <= 0 ||
    !Number.isFinite(expected) ||
    expected <= 0 ||
    !Number.isFinite(checksum) ||
    checksum > Number.MAX_SAFE_INTEGER ||
    checksum !== expected * iterations
  )
    throw Error('profile consumed-result checksum mismatch');
  if (
    !Number.isFinite(complete.elapsedMs) ||
    Number(complete.elapsedMs) < plan.durationMs ||
    Number(complete.elapsedMs) > 30000
  )
    throw Error('profile deadline mismatch');
  validateProfileWindow(complete, active.phaseAt, sampleStartedAt, sampleFinishedAt);
  for (const [key, path] of [
    ['binarySha256', binaryPath],
    ['bundleSha256', join(app, 'main.jsbundle')],
    ['infoPlistSha256', join(app, 'Info.plist')],
  ] as const)
    if ((await sha(path)) !== identity[key]) throw Error('profile artifact changed during capture');
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(
      {
        ...complete,
        provenance: {
          device,
          bundle,
          pid,
          processCommand,
          launchAt,
          sampleStartedAt,
          sampleFinishedAt,
          sampleArgs,
          sampleExitCode,
          ...identity,
          sampleSha256: await sha(join(output, 'sample.txt')),
        },
        interpretation:
          'CPU stack sample counts describe this workload and profiler. Use the JS execution thread only; all-thread wall samples and profiled iterations are not public throughput or causal time subtraction.',
      },
      null,
      2,
    ),
  );
  console.log(`Saved completed CPU profile: ${output}`);
} finally {
  if (sampler && sampler.exitCode === null) {
    sampler.kill();
    await sampler.exited;
  }
  simctl(['terminate', device, bundle], true);
  await writeFile(join(output, 'commands.json'), JSON.stringify(commands, null, 2));
}
