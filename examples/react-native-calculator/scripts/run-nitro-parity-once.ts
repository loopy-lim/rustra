#!/usr/bin/env bun
/** Single-launch variant of run-nitro-parity.ts for interleaved A/B installs.
 * Usage: bun scripts/run-nitro-parity-once.ts --device UDID --output DIR [--label arm]
 * The app must already be installed as com.rustra.nitroparity (per-arm build).
 * Validation is identical to run-nitro-parity.ts (same manifest + validateReceipt).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeBuildFingerprint } from './generate-build-fingerprint.mjs';
import { validateReceipt } from '../src/nitro-parity/receipt';
import { createExperimentManifest } from './parity-manifest';
import { requireDedicatedApp } from './parity-app-policy';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    device: { type: 'string' },
    output: { type: 'string' },
    'bundle-id': { type: 'string', default: 'com.rustra.nitroparity' },
    timeout: { type: 'string', default: '600' },
    label: { type: 'string', default: 'run' },
  },
});
if (!values.device || !values.output) throw new Error('--device and --output required');
const bundle = values['bundle-id']!;
requireDedicatedApp(bundle);
const timeout = Number(values.timeout) * 1000;
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('positive timeout required');
const device = values.device;

function simctl(args: string[], allowFailure = false) {
  const proc = Bun.spawnSync(['xcrun', 'simctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0 && !allowFailure) throw new Error(new TextDecoder().decode(proc.stderr));
  return new TextDecoder().decode(proc.stdout).trim();
}
const app = simctl(['get_app_container', device, bundle, 'app']);
const data = simctl(['get_app_container', device, bundle, 'data']);
const executable = Bun.spawnSync(
  ['/usr/libexec/PlistBuddy', '-c', 'Print CFBundleExecutable', join(app, 'Info.plist')],
  { stdout: 'pipe' },
);
if (executable.exitCode !== 0) throw new Error('cannot identify built binary');
const binaryPath = join(app, new TextDecoder().decode(executable.stdout).trim());
const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const binarySha256 = await sha(binaryPath);
const bundleSha256 = await sha(join(app, 'main.jsbundle'));
const { fingerprint } = await computeBuildFingerprint();
const manifest = createExperimentManifest(fingerprint);
const output = resolve(values.output);
await mkdir(output, { recursive: true });

simctl(['terminate', device, bundle], true);
const receiptPath = join(data, 'Documents', 'rustra-nitro-parity.json');
await unlink(receiptPath).catch((e: { code: string }) => {
  if (e.code !== 'ENOENT') throw e;
});
const after = Date.now();
const launch = simctl(['launch', device, bundle]);
console.log(`[${values.label}] launched: ${launch}`);
let receipt: unknown;
while (Date.now() - after < timeout) {
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    break;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  await Bun.sleep(1000);
}
if (!receipt) throw new Error(`[${values.label}] timed out; no parity receipt`);
validateReceipt(receipt, { ...manifest, after });
if ((await sha(binaryPath)) !== binarySha256)
  throw new Error(`[${values.label}] binary changed during experiment`);
await writeFile(
  join(output, 'receipt.json'),
  JSON.stringify(
    { label: values.label, binarySha256, bundleSha256, fingerprint, after, launch, receipt },
    null,
    2,
  ),
);
simctl(['terminate', device, bundle], true);
const cases = (receipt as { cases: unknown[] }).cases.length;
console.log(`[${values.label}] verified ${cases} cases -> ${join(output, 'receipt.json')}`);
