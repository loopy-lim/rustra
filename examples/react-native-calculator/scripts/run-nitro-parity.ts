#!/usr/bin/env bun
/** Usage: bun scripts/run-nitro-parity.ts --device UDID --output /absolute/new-directory */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeBuildFingerprint } from './generate-build-fingerprint.mjs';
import { aggregate, validateReceipt, type Receipt } from '../src/nitro-parity/receipt';
import { createExperimentManifest } from './parity-manifest';
import { requireDedicatedApp } from './parity-app-policy';
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    device: { type: 'string' },
    output: { type: 'string' },
    'bundle-id': { type: 'string', default: 'com.rustra.nitroparity' },
    launches: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '600' },
  },
});
if (!values.device || !values.output) throw new Error('--device and --output required');
const bundle = values['bundle-id']!;
requireDedicatedApp(bundle);
const launches = Number(values.launches),
  timeout = Number(values.timeout) * 1000;
if (!Number.isInteger(launches) || launches < 5 || !Number.isFinite(timeout) || timeout <= 0)
  throw new Error('five launches and positive timeout required');
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
const binarySha256 = await sha(binaryPath),
  bundleSha256 = await sha(join(app, 'main.jsbundle'));
const { fingerprint } = await computeBuildFingerprint();
const manifest = createExperimentManifest(fingerprint);
const output = resolve(values.output);
await mkdir(output, { recursive: false });
await writeFile(join(output, 'expected-experiment.json'), JSON.stringify(manifest, null, 2));
const receipts: Receipt[] = [],
  provenance: unknown[] = [];
for (let i = 0; i < launches; i++) {
  simctl(['terminate', device, bundle], true);
  const receiptPath = join(data, 'Documents', 'rustra-nitro-parity.json');
  await unlink(receiptPath).catch((e: { code: string }) => {
    if (e.code !== 'ENOENT') throw e;
  });
  const after = Date.now(),
    launch = simctl(['launch', device, bundle]);
  console.log(`Launch ${i + 1}/${launches}: ${launch}`);
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
  if (!receipt)
    throw new Error(`launch ${i + 1} timed out; no parity receipt (inspect app error output)`);
  validateReceipt(receipt, { ...manifest, after });
  receipts.push(receipt);
  if (
    (await sha(binaryPath)) !== binarySha256 ||
    (await sha(join(app, 'main.jsbundle'))) !== bundleSha256
  )
    throw new Error('binary/bundle changed during experiment');
  await writeFile(join(output, `launch-${i + 1}.json`), JSON.stringify(receipt, null, 2));
  provenance.push({
    runId: receipt.runId,
    launch,
    device,
    bundle,
    binarySha256,
    bundleSha256,
    fingerprint,
    after,
  });
  await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
  console.log(`Saved launch ${i + 1}: ${receipt.cases.length} verified cases`);
}
simctl(['terminate', device, bundle], true);
const results = aggregate(receipts, manifest);
await writeFile(
  join(output, 'summary.json'),
  JSON.stringify({ fingerprint, binarySha256, bundleSha256, results }, null, 2),
);
console.log(`Collected ${receipts.length} independent launches at ${output}`);
