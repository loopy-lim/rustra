import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function runSmoke(scenario, { crashHelper = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-ios-smoke-'));
  const calls = join(dir, 'calls.jsonl');
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
const a = process.argv.slice(2), scenario = process.env.SMOKE_SCENARIO;
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(a) + '\\n');
if (a[1] === 'list') {
  if (a.includes('-j')) console.log(JSON.stringify({ devices: { runtime: [{ name: 'iPhone test', udid: 'test-sim-id', isAvailable: true, state: 'Shutdown' }] } }));
  else console.log('    iPhone test (test-sim-id) (Shutdown)');
}
if (a[1] === 'install' && scenario === 'install-failure') process.exit(7);
if (a[1] === 'launch') {
  if (scenario === 'launch-failure') process.exit(8);
  if (!a.includes('--console-pty')) console.log('com.alt-shifted.react-native-calculator: ' + (scenario === 'invalid-pid' ? 'invalid' : process.env.SMOKE_APP_PID));
}
if (a[1] === 'spawn' && a.includes('log') && a.includes('show')) {
  if (scenario === 'log-failure') process.exit(9);
  if (['success', 'both', 'dead', 'permission-denied', 'helper-failure'].includes(scenario)) console.log('__RUSTRA_SMOKE_OK__ addNumbers(42,58)=100');
  if (['failure', 'both'].includes(scenario)) console.log('__RUSTRA_SMOKE_FAIL__');
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
`,
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
      },
    });
    assert.ifError(result.error);
    const diagnostic = (name) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined;
    return {
      ...result,
      calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
      killError: diagnostic('rustra-ios-kill.stderr.log'),
      processDiagnostic: diagnostic('rustra-ios-process.log'),
      crashSummary: diagnostic('rustra-ios-crash-summary.json'),
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
  assert.equal(query[query.indexOf('--process') + 1], '4242');
  assert.match(query[query.indexOf('--start') + 1], /^@\d+$/);
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
  assert.ok(!result.calls.some((a) => ['ps', 'crash-summary'].includes(a[0])));
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
      assert.ok(!result.calls.some((a) => a[1] === 'spawn'));
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
