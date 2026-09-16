#!/usr/bin/env bun
/** Collect an already-installed dedicated APK; never install, uninstall or clear device logs. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ExperimentManifest } from '../src/nitro-parity/receipt';
import { collectAndroid } from './parity-android-host';
import { requireDedicatedApp } from './parity-app-policy';

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    apk: { type: 'string' },
    manifest: { type: 'string' },
    output: { type: 'string' },
    package: { type: 'string', default: 'com.rustra.nitroparity' },
    launches: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '600' },
  },
});
if (!values.device || !values.apk || !values.manifest || !values.output) {
  throw new Error('--device, --apk, --manifest and --output are required');
}
const appId = values.package!;
requireDedicatedApp(appId);
const launches = Number(values.launches),
  timeout = Number(values.timeout) * 1000;
if (!Number.isInteger(launches) || launches < 5 || !Number.isFinite(timeout) || timeout <= 0) {
  throw new Error('five launches and positive timeout required');
}
function adb(args: string[]): string {
  const process = Bun.spawnSync(['adb', '-s', values.device!, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(process.stdout);
  const stderr = new TextDecoder().decode(process.stderr);
  if (process.exitCode !== 0)
    throw Object.assign(new Error(stderr || `adb exited ${process.exitCode}`), { stdout, stderr });
  return args[0] === 'logcat' ? stdout : stdout.trim();
}
const manifestText = await readFile(resolve(values.manifest), 'utf8');
const manifest: ExperimentManifest = JSON.parse(manifestText);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const apkSha256 = sha(await readFile(resolve(values.apk)));
const packagePath = adb(['shell', 'pm', 'path', appId]);
if (!/^package:\/data\/app\/[a-zA-Z0-9_./=+~-]+\/base\.apk$/.test(packagePath)) {
  throw new Error('expected one dedicated base APK');
}
const installedPath = packagePath.slice('package:'.length);
function verifyInstalled() {
  const installedHash = adb(['shell', 'sha256sum', installedPath]).split(/\s+/)[0];
  if (installedHash !== apkSha256)
    throw new Error('installed APK differs from frozen benchmark APK');
  return installedHash;
}
const installedHashBefore = verifyInstalled();
const component = adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', appId])
  .split('\n')
  .at(-1)!;
if (!component.startsWith(`${appId}/`) || !/^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+$/.test(component)) {
  throw new Error('cannot resolve dedicated activity');
}
const directory = resolve(values.output);
await mkdir(directory, { recursive: false });
await collectAndroid(
  {
    adb,
    now: () => performance.now(),
    sleep: (ms) => Bun.sleep(ms),
    save: async (name, text) => {
      // A failed write never exposes a partial success summary or JSON receipt.
      const temporary = join(directory, `.${name}.tmp`);
      await writeFile(temporary, text);
      await rename(temporary, join(directory, name));
      if (/^launch-\d+-provenance\.json$/.test(name)) {
        const record = JSON.parse(text);
        console.log(
          `Launch ${record.index}/${launches}: ${record.status}, PID ${record.pid ?? 'unavailable'}`,
        );
      }
    },
  },
  {
    appId,
    component,
    installedPath,
    apkSha256,
    installedHashBefore,
    serial: values.device,
    manifest,
    manifestText,
    manifestSha256: sha(manifestText),
    launches,
    timeout,
  },
);
