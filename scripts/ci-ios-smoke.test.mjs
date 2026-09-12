import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function runSmoke(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-ios-smoke-'));
  const calls = join(dir, 'calls.jsonl');
  const yaml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const step = yaml.match(
    / {6}- name: Simulator runtime smoke[^\n]*\n[\s\S]*? {8}run: ([^\n]+)\n((?: {10}.*\n|\n)*)/,
  );
  assert.ok(step);
  const program = step[1] === '|' ? step[2].replace(/^ {10}/gm, '') : step[1];
  writeFileSync(join(dir, 'step.sh'), program);
  mkdirSync(
    join(dir, 'rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app'),
    { recursive: true },
  );
  writeFileSync(
    join(dir, 'xcrun'),
    `#!/usr/bin/env node
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
  if (!a.includes('--console-pty')) console.log('com.alt-shifted.react-native-calculator: ' + (scenario === 'invalid-pid' ? 'invalid' : scenario === 'dead' ? '2147483647' : process.env.SMOKE_APP_PID));
}
if (a[1] === 'spawn' && a.includes('log') && a.includes('show')) {
  if (scenario === 'log-failure') process.exit(9);
  if (['success', 'both', 'dead'].includes(scenario)) console.log('__RUSTRA_SMOKE_OK__ addNumbers(42,58)=100');
  if (['failure', 'both'].includes(scenario)) console.log('__RUSTRA_SMOKE_FAIL__');
}
`,
    { mode: 0o755 },
  );
  // Keep the legacy script's polling bounded while reproducing its wrong log source.
  writeFileSync(join(dir, 'seq'), '#!/bin/sh\necho 1\n', { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const result = spawnSync('bash', [join(dir, 'step.sh')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        RUSTRA_SMOKE_ATTEMPTS: '1',
        RUSTRA_SMOKE_DELAY_SECONDS: '0',
        SMOKE_CALLS: calls,
        SMOKE_SCENARIO: scenario,
        SMOKE_APP_PID: String(process.pid),
      },
    });
    assert.ifError(result.error);
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('iOS reads the launched app success marker from unified logging', () => {
  const result = runSmoke('success');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const query = result.calls.find((a) => a[1] === 'spawn' && a.includes('show'));
  assert.ok(query, 'React Native emits os_log, not stdout/stderr');
  assert.equal(query[query.indexOf('--process') + 1], String(process.pid));
  assert.match(query[query.indexOf('--start') + 1], /^@\d+$/);
  assert.ok(result.calls.some((a) => a[1] === 'terminate'));
});
for (const scenario of [
  'failure',
  'both',
  'missing',
  'dead',
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
  });
}
