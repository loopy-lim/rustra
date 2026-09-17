#!/usr/bin/env bun
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SCHEDULES,
  DIAGNOSTIC_CASES,
  validateDiagnostic,
  type Schedule,
  type DiagnosticCase,
} from '../src/nitro-parity/diagnostic';
import { extractAndroidReceipt } from './parity-android-chunks';
const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    apk: { type: 'string' },
    fingerprint: { type: 'string' },
    output: { type: 'string' },
    cases: { type: 'string', default: 'buffer65536,buffer1048571' },
    schedules: { type: 'string', default: SCHEDULES.join(',') },
    launches: { type: 'string', default: '5' },
  },
});
if (
  !values.device ||
  !values.apk ||
  !values.output ||
  !values.fingerprint ||
  !/^[a-f0-9]{64}$/.test(values.fingerprint)
)
  throw Error('device, apk, output, fingerprint required');
const cases = values.cases!.split(',') as DiagnosticCase[],
  schedules = values.schedules!.split(',') as Schedule[],
  launches = Number(values.launches);
if (
  !cases.every((c) => DIAGNOSTIC_CASES.includes(c)) ||
  !schedules.every((s) => SCHEDULES.includes(s)) ||
  new Set(cases).size !== cases.length ||
  new Set(schedules).size !== schedules.length ||
  !Number.isInteger(launches) ||
  launches < 1 ||
  launches > 5
)
  throw Error('invalid bounded diagnostic plan');
const app = 'com.rustra.nitroparity',
  output = resolve(values.output);
function adb(args: string[]) {
  const proc = Bun.spawnSync(['adb', '-s', values.device!, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = new TextDecoder().decode(proc.stdout);
  if (proc.exitCode !== 0)
    throw Error(new TextDecoder().decode(proc.stderr) || `adb failed: ${args[0]}`);
  return out.trim();
}
const apkHash = createHash('sha256')
  .update(await readFile(resolve(values.apk)))
  .digest('hex');
const installed = adb(['shell', 'pm', 'path', app]).replace(/^package:/, '');
if (!/^\/data\/app\/[a-zA-Z0-9_./=+~-]+\/base\.apk$/.test(installed))
  throw Error('invalid installed dedicated APK');
const hash = () => adb(['shell', 'sha256sum', installed]).split(/\s+/)[0];
if (hash() !== apkHash) throw Error('installed APK mismatch');
const component = adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', app])
  .split('\n')
  .at(-1)!;
if (!component.startsWith(app + '/') || !/^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+$/.test(component))
  throw Error('invalid dedicated activity');
await mkdir(output, { recursive: false });
const manifest = {
  app,
  apkHash,
  fingerprint: values.fingerprint,
  cases,
  schedules,
  launches,
  device: values.device,
  model: adb(['shell', 'getprop', 'ro.product.model']),
  android: adb(['shell', 'getprop', 'ro.build.version.release']),
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const receipts: unknown[] = [],
  pids = new Set<string>();
let failure: unknown;
try {
  for (let launch = 1; launch <= launches; launch++)
    for (const caseId of cases)
      for (const schedule of schedules) {
        const runId = `diag-${Date.now()}-${launch}`,
          expected = {
            caseId,
            schedule,
            runId,
            fingerprint: values.fingerprint,
            after: Number(adb(['shell', 'date', '+%s'])) * 1000,
          };
        const name = `${caseId}-${schedule}-${launch}`;
        let raw = '',
          pid = '';
        try {
          adb(['shell', 'am', 'force-stop', app]);
          const url = `rustra://diagnostic?case=${caseId}&schedule=${schedule}&run=${runId}`;
          adb([
            'shell',
            'am',
            'start',
            '-W',
            '-n',
            component,
            '-a',
            'android.intent.action.VIEW',
            '-d',
            `'${url}'`,
          ]);
          pid = adb(['shell', 'pidof', app]);
          if (!/^\d+$/.test(pid) || pids.has(pid)) throw Error('fresh process required');
          pids.add(pid);
          const start = performance.now();
          let result: unknown;
          while (performance.now() - start < 60000) {
            raw = adb(['logcat', '--pid', pid, '-d', '-v', 'raw', '-s', 'ReactNativeJS:I']);
            result = extractAndroidReceipt(raw);
            if (result !== undefined) break;
            if (adb(['shell', 'pidof', app]) !== pid) throw Error('diagnostic app exited');
            await Bun.sleep(250);
          }
          const receipt = validateDiagnostic(result, expected);
          if (hash() !== apkHash) throw Error('APK changed during diagnostic');
          const record = { ...receipt, provenance: { pid, launch, apkHash } };
          receipts.push(record);
          await writeFile(join(output, name + '.json'), JSON.stringify(record, null, 2));
          console.log(`Saved ${name}: ${receipt.samples.length} samples`);
        } finally {
          await writeFile(join(output, name + '.log'), raw);
        }
      }
} catch (error) {
  failure = error;
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify({ message: String(error), completed: receipts.length }, null, 2),
  );
} finally {
  adb(['shell', 'am', 'force-stop', app]);
}
if (failure) throw failure;
await writeFile(join(output, 'complete.json'), JSON.stringify({ manifest, receipts }, null, 2));
