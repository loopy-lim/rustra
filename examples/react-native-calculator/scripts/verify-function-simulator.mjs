import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computeBuildFingerprint, DEFAULT_APP_ROOT } from './generate-build-fingerprint.mjs';

const CHECKS = [
  ['add(42, 58)', 100],
  ['greetPerson("민지")', 'Hello, 민지!'],
  ['remember(100) returns void', 'undefined'],
  ['readRemembered()', 100],
  ['reset() returns void', 'undefined'],
  ['reset clears Rust state', 0],
  ['safeDivide(84, 2)', 42],
  ['zero divisor maps domain error', 'math.zero_divisor'],
  ['function uses supported JS frame route', 0],
  ['live schema add', 100],
  ['live schema reset returns void', 'undefined'],
  ['cursor matches generated wire', '34,0,84,116'],
  ['legacy addNumbers still works', 100],
];

export function validateReceipt(
  receipt,
  { fingerprint, contractHash, startedAt, now = Date.now() },
) {
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  require(receipt.kind === 'rustra-ordinary-functions' &&
    receipt.schemaVersion === 1, 'Wrong receipt kind/version');
  const generatedAt = Date.parse(receipt.generatedAt);
  require(generatedAt >= startedAt &&
    generatedAt <= now, 'Receipt is stale or dated in the future');
  require(receipt.platform === 'ios' && receipt.buildMode === 'release', 'Expected iOS Release');
  require(receipt.buildFingerprint === fingerprint, 'Rebuild the app: source fingerprint differs');
  require(receipt.contractHash === contractHash, 'Rebuild the app: contract differs');
  require(receipt.correctness?.passed === true &&
    receipt.correctness?.checkedBeforeTiming === true, 'Correctness did not pass before timing');
  require(receipt.checks?.length === CHECKS.length, 'Missing function checks');
  for (const [name, actual] of CHECKS) {
    require(receipt.checks.some(
      (check) => check.name === name && check.passed === true && Object.is(check.actual, actual),
    ), `Failed check: ${name}`);
  }
  require(receipt.benchmark?.samples === 20 &&
    receipt.benchmark?.checksum === 11211552, 'Incomplete benchmark');
  for (const name of ['generatedFunction', 'legacyCommand', 'encode', 'encodeInto']) {
    const stats = receipt.benchmark.nanoseconds?.[name];
    require(stats?.batchMeans?.length === 20 &&
      stats.batchMeans.every((n) => Number.isFinite(n) && n > 0) &&
      Number.isFinite(stats.p50) &&
      stats.p50 > 0, `Invalid benchmark: ${name}`);
  }
  return receipt;
}

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function main() {
  const { values } = parseArgs({
    options: {
      device: { type: 'string', default: 'booted' },
      runs: { type: 'string', default: '3' },
      output: { type: 'string' },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be 1..20');
  const devices = JSON.parse(simctl('list', 'devices', '--json')).devices;
  const matches = Object.entries(devices).flatMap(([runtime, entries]) =>
    entries
      .filter(
        (entry) =>
          entry.state === 'Booted' && (values.device === 'booted' || entry.udid === values.device),
      )
      .map((entry) => ({ udid: entry.udid, name: entry.name, runtime })),
  );
  if (matches.length !== 1) throw new Error('Select one booted Simulator with --device <UDID>');
  const simulator = matches[0];
  const device = simulator.udid;
  const output = resolve(values.output ?? `/tmp/rustra-functions-${Date.now()}`);
  await mkdir(output, { recursive: false });
  const { fingerprint } = await computeBuildFingerprint();
  const contract = await readFile(resolve(DEFAULT_APP_ROOT, 'generated/contract.ts'), 'utf8');
  const contractHash = contract.match(/GENERATED_CONTRACT_HASH\s*=\s*['"]([a-f0-9]+)['"]/)?.[1];
  if (!contractHash) throw new Error('Generated contract hash is missing');
  const bundleId = JSON.parse(await readFile(resolve(DEFAULT_APP_ROOT, 'app.json'), 'utf8')).expo
    .ios.bundleIdentifier;
  const app = simctl('get_app_container', device, bundleId, 'app');
  const executable = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', resolve(app, 'Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  const manifest = {
    demo: 'functions',
    configuration: 'Release',
    simulator,
    bundleId,
    fingerprint,
    contractHash,
    artifacts: {},
    runs: [],
  };
  for (const name of [executable, 'main.jsbundle'])
    manifest.artifacts[name] = sha256(await readFile(resolve(app, name)));
  for (let run = 1; run <= runs; run++) {
    // Stop the old writer before clearing its receipt and starting the clock.
    // A timestamp taken before termination could accept that old process's final write.
    try {
      simctl('terminate', device, bundleId);
    } catch (error) {
      if (!String(error.stderr).includes('NSPOSIXErrorDomain, code=3')) throw error;
    }
    const data = simctl('get_app_container', device, bundleId, 'data');
    const receiptPath = resolve(data, 'Documents/rustra-function-receipt.json');
    await unlink(receiptPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const startedAt = Date.now();
    const launch = simctl('launch', device, bundleId);
    let receipt;
    while (Date.now() - startedAt < 60_000) {
      try {
        const candidate = JSON.parse(await readFile(receiptPath, 'utf8'));
        if (Date.parse(candidate.generatedAt) >= startedAt) {
          receipt = validateReceipt(candidate, { fingerprint, contractHash, startedAt });
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!receipt)
      throw new Error(
        'No fresh receipt. Build with EXPO_PUBLIC_RUSTRA_DEMO=functions and inspect Simulator/logs.',
      );
    const raw = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(resolve(output, `run-${run}.json`), raw, { flag: 'wx' });
    manifest.runs.push({
      run,
      launch,
      startedAt: new Date(startedAt).toISOString(),
      generatedAt: receipt.generatedAt,
      receiptSha256: sha256(raw),
    });
    console.log(
      `Run ${run}: ${receipt.checks.length} checks; function p50 ${(receipt.benchmark.nanoseconds.generatedFunction.p50 / 1000).toFixed(2)} us`,
    );
  }
  if ((await computeBuildFingerprint()).fingerprint !== fingerprint)
    throw new Error('Sources changed during measurement');
  for (const [name, hash] of Object.entries(manifest.artifacts)) {
    if (sha256(await readFile(resolve(app, name))) !== hash)
      throw new Error('Installed app changed during measurement');
  }
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(`Verified ${runs} fresh launches: ${output}`);
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
