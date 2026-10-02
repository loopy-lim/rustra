import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function runSmoke(
  scenario,
  {
    crashHelper = true,
    nativeStderr = true,
    nativeStderrBody = 'controlled native stderr\n',
    nativeCopyFailure = false,
    nativePrepFailure,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-ios-smoke-'));
  const calls = join(dir, 'calls.jsonl');
  const simulatorRoot = join(dir, 'simulator-data');
  mkdirSync(simulatorRoot);
  const yaml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const step = yaml.match(
    / {6}- name: Simulator runtime smoke[^\n]*\n[\s\S]*? {8}run: ([^\n]+)\n((?: {10}.*\n|\n)*)/,
  );
  assert.ok(step);
  const program = step[1] === '|' ? step[2].replace(/^ {10}/gm, '') : step[1];
  writeFileSync(join(dir, 'step.sh'), program);
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(
    join(dir, 'scripts/ci-ios-runtime-smoke.sh'),
    readFileSync(join(root, 'scripts/ci-ios-runtime-smoke.sh')),
  );
  if (crashHelper) {
    writeFileSync(
      join(dir, 'scripts/ci-ios-crash-summary.mjs'),
      `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(['crash-summary', ...args]) + '\\n');
if (process.env.SMOKE_SCENARIO === 'helper-failure') {
  console.error('controlled crash-summary failure');
  process.exit(17);
}
fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ status: 'no-report', reports: [] }) + '\\n');
`,
    );
  }
  mkdirSync(
    join(dir, 'rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app'),
    { recursive: true },
  );
  writeFileSync(
    join(dir, 'xcrun'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2), scenario = process.env.SMOKE_SCENARIO;
const simFile = value => path.join(process.env.SMOKE_SIMULATOR_ROOT, value);
const writeNative = (value, contents) => {
  fs.mkdirSync(path.dirname(simFile(value)), { recursive: true });
  fs.writeFileSync(simFile(value), contents);
};
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(a) + '\\n');
if (a[1] === 'list') {
  if (a.includes('-j')) console.log(JSON.stringify({ devices: { runtime: [{ name: 'iPhone test', udid: 'test-sim-id', isAvailable: true, state: 'Shutdown' }] } }));
  else console.log('    iPhone test (test-sim-id) (Shutdown)');
}
if (a[1] === 'getenv') {
  if (process.env.SMOKE_NATIVE_PREP_FAILURE === 'getenv') process.exit(31);
  console.log(process.env.SMOKE_SIMULATOR_ROOT);
}
if (a[1] === 'install' && scenario === 'install-failure') process.exit(7);
if (a[1] === 'launch') {
  if (scenario === 'launch-failure') process.exit(8);
  const stdout = a.find(value => value.startsWith('--stdout='));
  const stderr = a.find(value => value.startsWith('--stderr='));
  if (stdout) writeNative(stdout.slice('--stdout='.length), 'controlled native stdout\\n');
  if (stderr && process.env.SMOKE_NATIVE_STDERR === '1') writeNative(stderr.slice('--stderr='.length), process.env.SMOKE_NATIVE_STDERR_BODY);
  if (!a.includes('--console-pty')) console.log('com.alt-shifted.react-native-calculator: ' + (scenario === 'invalid-pid' ? 'invalid' : process.env.SMOKE_APP_PID));
}
if (a[1] === 'spawn' && a[3] === 'mkdir') {
  console.error('controlled unavailable simulator mkdir');
  process.exit(2);
}
if (a[1] === 'spawn' && a.includes('log') && a.includes('show')) {
  if (scenario === 'log-failure') process.exit(9);
  const predicate = a[a.indexOf('--predicate') + 1];
  const ownPidOnly = !a.includes('--process') && predicate.includes('processIdentifier == 4242');
  if (['success', 'both', 'dead', 'permission-denied', 'helper-failure'].includes(scenario)) console.log('__RUSTRA_SMOKE_OK__ addNumbers(42,58)=100');
  if (['failure', 'both'].includes(scenario)) console.log('__RUSTRA_SMOKE_FAIL__');
  // Apple's log selectors are OR-combined unless the PID is in the same predicate.
  if (scenario === 'foreign-ok' && !ownPidOnly) console.log('__RUSTRA_SMOKE_OK__ another process');
  if (scenario === 'foreign-fail') {
    console.log('__RUSTRA_SMOKE_OK__ addNumbers(42,58)=100');
    if (!ownPidOnly) console.log('__RUSTRA_SMOKE_FAIL__ another process');
  }
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'bash-env'),
    `kill() {
  if [[ "$#" != 2 || "$1" != '-0' || "$2" != '4242' ]]; then
    echo 'unexpected kill arguments' >&2
    return 95
  fi
  printf '%s\\n' '["kill","-0","4242"]' >> "$SMOKE_CALLS"
  case "$SMOKE_SCENARIO" in
    dead|helper-failure) echo 'controlled kill: No such process' >&2; return 1 ;;
    permission-denied) echo 'controlled kill: Operation not permitted' >&2; return 1 ;;
    *) return 0 ;;
  esac
}
mkdir() {
  if [[ "$SMOKE_NATIVE_PREP_FAILURE" == 'mkdir' ]]; then
    echo 'controlled native directory preparation failure' >&2
    return 32
  fi
  command mkdir "$@"
}
`,
  );
  writeFileSync(
    join(dir, 'cp'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(['cp', ...args]) + '\\n');
if (process.env.SMOKE_NATIVE_COPY_FAILURE === '1') process.exit(23);
try { fs.copyFileSync(args[0], args[1]); } catch { process.exit(23); }
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'ps'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(['ps', ...process.argv.slice(2)]) + '\\n');
if (['dead', 'helper-failure'].includes(process.env.SMOKE_SCENARIO)) process.exit(1);
console.log('4242 501 S reactnativecalculator');
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const result = spawnSync('bash', [join(dir, 'step.sh')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        RUSTRA_SMOKE_ATTEMPTS: '1',
        RUSTRA_SMOKE_DELAY_SECONDS: '0',
        BASH_ENV: join(dir, 'bash-env'),
        SMOKE_CALLS: calls,
        SMOKE_SCENARIO: scenario,
        SMOKE_APP_PID: '4242',
        SMOKE_NATIVE_STDERR: nativeStderr ? '1' : '0',
        SMOKE_NATIVE_STDERR_BODY: nativeStderrBody,
        SMOKE_SIMULATOR_ROOT: simulatorRoot,
        SMOKE_NATIVE_COPY_FAILURE: nativeCopyFailure ? '1' : '0',
        SMOKE_NATIVE_PREP_FAILURE: nativePrepFailure ?? '',
      },
    });
    assert.ifError(result.error);
    const diagnostic = (name) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined;
    const recordedCalls = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    return {
      ...result,
      calls: recordedCalls,
      killError: diagnostic('rustra-ios-kill.stderr.log'),
      processDiagnostic: diagnostic('rustra-ios-process.log'),
      crashSummary: diagnostic('rustra-ios-crash-summary.json'),
      nativeStdout: diagnostic('rustra-ios-native.stdout.log'),
      nativeStderr: diagnostic('rustra-ios-native.stderr.log'),
      simulatorRoot,
      runnerTemp: dir,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('iOS reads the launched app success marker from unified logging', () => {
  const result = runSmoke('success');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const query = result.calls.find((a) => a[1] === 'spawn' && a.includes('show'));
  assert.ok(query, 'React Native emits os_log, not stdout/stderr');
  assert.ok(!query.includes('--process'));
  assert.equal(
    query[query.indexOf('--predicate') + 1],
    '(processIdentifier == 4242) AND subsystem == "com.facebook.react.log" AND category == "javascript" AND eventMessage CONTAINS "__RUSTRA_SMOKE_"',
  );
  assert.match(query[query.indexOf('--start') + 1], /^@\d+$/);
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
  assert.ok(!result.calls.some((a) => ['ps', 'crash-summary'].includes(a[0])));
});

test('iOS rejects a foreign process OK marker when the launched app emits none', () => {
  const result = runSmoke('foreign-ok');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /__RUSTRA_SMOKE_OK__ was not observed/);
  assert.doesNotMatch(result.stdout, /smoke OK:/);
});

test('iOS accepts the launched app OK without a foreign process FAIL marker', () => {
  const result = runSmoke('foreign-fail');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /smoke OK: pid=4242/);
  assert.doesNotMatch(result.stderr, /__RUSTRA_SMOKE_FAIL__ observed/);
});
for (const scenario of [
  'failure',
  'both',
  'missing',
  'dead',
  'permission-denied',
  'install-failure',
  'launch-failure',
  'log-failure',
  'invalid-pid',
]) {
  test(`iOS rejects ${scenario}`, () => {
    const result = runSmoke(scenario);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    if (['install-failure', 'launch-failure'].includes(scenario)) {
      assert.ok(!result.calls.some((a) => a[1] === 'spawn' && a.includes('show')));
    }
    if (['install-failure', 'launch-failure', 'log-failure', 'invalid-pid'].includes(scenario)) {
      assert.ok(!result.calls.some((a) => ['ps', 'crash-summary'].includes(a[0])));
    }
  });
}

test('iOS liveness diagnostics retain the kill error and query only the launched PID', () => {
  const result = runSmoke('dead');
  assert.equal(result.status, 1);
  assert.equal(result.killError, 'controlled kill: No such process\n');
  assert.match(result.stderr, /controlled kill: No such process/);
  assert.deepEqual(
    result.calls.find((a) => a[0] === 'ps'),
    ['ps', '-p', '4242', '-o', 'pid=,uid=,stat=,comm='],
  );
});

test('iOS liveness diagnostics expose EPERM without accepting an OK marker', () => {
  const result = runSmoke('permission-denied');
  assert.equal(result.status, 1);
  assert.equal(result.killError, 'controlled kill: Operation not permitted\n');
  assert.equal(result.processDiagnostic, '4242 501 S reactnativecalculator\n');
  assert.match(result.stderr, /Operation not permitted/);
  assert.match(result.stderr, /4242 501 S reactnativecalculator/);
  assert.doesNotMatch(result.stdout, /smoke OK:/);
});

for (const scenario of ['failure', 'both', 'missing', 'dead']) {
  test(`iOS crash summary diagnostics for ${scenario} use the launch scope`, () => {
    const result = runSmoke(scenario);
    assert.equal(result.status, 1);
    const query = result.calls.find((a) => a[1] === 'spawn' && a.includes('show'));
    const summary = result.calls.find((a) => a[0] === 'crash-summary');
    assert.ok(summary);
    if (['failure', 'both'].includes(scenario)) {
      assert.ok(!result.calls.some((a) => a[0] === 'kill'));
    }
    assert.deepEqual(summary.slice(1, 7), [
      '--pid',
      '4242',
      '--started-at',
      query[query.indexOf('--start') + 1],
      '--sim-id',
      'test-sim-id',
    ]);
    assert.equal(summary[7], '--output');
    assert.match(summary[8], /\/rustra-ios-crash-summary\.json$/);
    assert.deepEqual(JSON.parse(result.crashSummary), { status: 'no-report', reports: [] });
    assert.match(result.stderr, /"status":"no-report"/);
  });
}

test('iOS failure diagnostics cannot mask a failing crash helper', () => {
  const result = runSmoke('helper-failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app process is not alive: 4242/);
  assert.match(result.stderr, /controlled crash-summary failure/);
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
});

test('iOS failure diagnostics cannot mask a missing crash helper', () => {
  const result = runSmoke('dead', { crashHelper: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /controlled kill: No such process/);
  assert.ok(!result.calls.some((a) => a[0] === 'crash-summary'));
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
});

test('iOS captures native streams from the same launch without printing them on success', () => {
  const result = runSmoke('success');
  assert.equal(result.status, 0);
  const launches = result.calls.filter((a) => a[1] === 'launch');
  assert.equal(launches.length, 1);
  const stdout = launches[0].find((a) => a.startsWith('--stdout='));
  const stderr = launches[0].find((a) => a.startsWith('--stderr='));
  assert.match(stdout, /^--stdout=\/tmp\/rustra-ios-native-\d+-\d+\/rustra-ios-native.stdout.log$/);
  assert.equal(stderr, stdout.replace('--stdout=', '--stderr=').replace('.stdout.', '.stderr.'));
  const prep = result.calls.find((a) => a[1] === 'getenv');
  assert.deepEqual(prep, [
    'simctl',
    'getenv',
    'test-sim-id',
    'SIMULATOR_SHARED_RESOURCES_DIRECTORY',
  ]);
  assert.ok(result.calls.indexOf(prep) < result.calls.indexOf(launches[0]));
  assert.ok(!result.calls.some((a) => a[1] === 'spawn' && ['cat', 'mkdir'].includes(a[3])));
  assert.ok(!result.calls.some((a) => a[0] === 'cp'));
  assert.ok(!launches[0].some((a) => ['--console', '--console-pty'].includes(a)));
  assert.equal(result.nativeStdout, undefined);
  assert.equal(result.nativeStderr, undefined);
  assert.doesNotMatch(result.stdout + result.stderr, /controlled native/);
});

test('iOS native stderr failure diagnostics retain the full file but print at most 80 lines', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `native line ${i + 1}`);
  const nativeStderrBody = `${lines.join('\n')}\n`;
  const result = runSmoke('failure', { nativeStderrBody });
  assert.equal(result.status, 1);
  assert.equal(result.nativeStderr, nativeStderrBody);
  assert.equal(result.nativeStdout, 'controlled native stdout\n');
  const copies = result.calls.filter((a) => a[0] === 'cp');
  const launch = result.calls.find((a) => a[1] === 'launch');
  assert.deepEqual(
    copies,
    ['--stdout', '--stderr'].map((flag) => [
      'cp',
      join(
        result.simulatorRoot,
        launch.find((a) => a.startsWith(`${flag}=`)).slice(flag.length + 1),
      ),
      join(
        result.runnerTemp,
        flag === '--stdout' ? 'rustra-ios-native.stdout.log' : 'rustra-ios-native.stderr.log',
      ),
    ]),
  );
  const printed = result.stderr.split('\n').filter((line) => /^native line \d+$/.test(line));
  assert.equal(printed.length, 80);
  assert.equal(printed[0], 'native line 41');
  assert.equal(printed.at(-1), 'native line 120');
  assert.doesNotMatch(result.stderr, /controlled native stdout/);
});

test('iOS native stderr failure diagnostics bound a single large native log line', () => {
  const result = runSmoke('failure', { nativeStderrBody: `${'X'.repeat(20_000)}\n` });
  assert.equal(result.status, 1);
  const printed = result.stderr.split('\n').find((line) => /^X+$/.test(line));
  assert.ok(printed);
  assert.ok(Buffer.byteLength(printed) <= 16_384);
  assert.equal(result.nativeStderr.length, 20_001);
});

test('iOS native stderr failure diagnostics tolerate a missing capture file', () => {
  const result = runSmoke('dead', { nativeStderr: false });
  assert.equal(result.status, 1);
  assert.equal(result.nativeStderr, undefined);
  assert.equal(result.calls.filter((a) => a[0] === 'cp').length, 2);
  assert.match(result.stderr, /native stderr.*empty or unavailable/);
  assert.match(result.stderr, /controlled kill: No such process/);
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
});

test('iOS native capture copy failure cannot mask the original smoke failure', () => {
  const result = runSmoke('dead', { nativeCopyFailure: true });
  assert.equal(result.status, 1);
  assert.equal(result.calls.filter((a) => a[0] === 'cp').length, 2);
  assert.equal(result.nativeStdout, undefined);
  assert.equal(result.nativeStderr, undefined);
  assert.match(result.stderr, /app process is not alive: 4242/);
  assert.match(result.stderr, /native stderr.*empty or unavailable/);
  assert.match(result.stderr, /controlled kill: No such process/);
  assert.ok(result.calls.some((a) => a[0] === 'crash-summary'));
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
});

for (const nativePrepFailure of ['getenv', 'mkdir']) {
  for (const scenario of ['success', 'dead']) {
    test(`iOS unavailable native ${nativePrepFailure} diagnostics preserve the ${scenario} gate`, () => {
      const result = runSmoke(scenario, { nativePrepFailure });
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
      const launches = result.calls.filter((a) => a[1] === 'launch');
      assert.equal(launches.length, 1);
      assert.ok(!launches[0].some((a) => /^--std(out|err)=/.test(a)));
      assert.ok(!result.calls.some((a) => a[0] === 'cp'));
      assert.ok(result.calls.some((a) => a[1] === 'terminate'));
    });
  }
}
