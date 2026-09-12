import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/ci-android-runtime-smoke.sh');

for (const job of ['rn-android', 'uniffi-android']) {
  test(`${job} passes a complete shell program to the emulator action`, () => {
    const yaml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const section = yaml.match(
      new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|(?![\\s\\S]))`, 'm'),
    )?.[1];
    assert.ok(section);
    const match = section.match(/ {10}script: (.*)\n((?: {12}.*\n|\n)*)/);
    assert.ok(match);
    const text = match[1] === '|' ? match[2] : match[1];
    // The action executes each non-comment line in a separate `sh -c` process.
    const commands = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    for (const command of commands) execFileSync('sh', ['-n', '-c', command]);
    assert.equal(commands.length, 1, 'variables, loops and assertions must share one shell');
  });
}

function runSmoke(host, scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-mobile-smoke-'));
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(
    join(dir, 'adb'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(args) + '\\n');
const scenario = process.env.SMOKE_SCENARIO;
if (args[0] === 'install' && scenario === 'install-failure') process.exit(7);
if (args[0] === 'logcat' && args[1] === '-d') {
  if (scenario === 'success' || scenario === 'dead' || scenario === 'both') console.log(process.env.SMOKE_OK);
  if (scenario === 'failure' || scenario === 'both') console.log(process.env.SMOKE_FAIL);
}
if (args[0] === 'shell' && args[1] === 'pidof' && scenario !== 'dead') console.log('1234');
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync('bash', [script, host], {
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
        SMOKE_OK:
          host === 'rn' ? '__RUSTRA_SMOKE_OK__' : '__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42',
        SMOKE_FAIL: host === 'rn' ? '__RUSTRA_SMOKE_FAIL__' : '__RUSTRA_UNIFFI_FAIL__',
      },
    });
    assert.ifError(result.error);
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const host of ['rn', 'uniffi']) {
  test(`${host} requires its success marker and a surviving app process`, () => {
    const result = runSmoke(host, 'success');
    assert.equal(result.status, 0, result.stderr);
    const appId =
      host === 'rn' ? 'com.altshifted.reactnativecalculator' : 'dev.rustra.uniffi.smoke';
    assert.ok(result.calls.some((args) => args[0] === 'install'));
    assert.ok(
      result.calls.some((args) => args[0] === 'shell' && args[1] === 'monkey' && args[3] === appId),
    );
    assert.ok(
      result.calls.some((args) => args[0] === 'shell' && args[1] === 'pidof' && args[2] === appId),
    );
  });
  for (const scenario of ['failure', 'both', 'dead', 'missing', 'install-failure']) {
    test(`${host} rejects ${scenario}`, () => {
      const result = runSmoke(host, scenario);
      assert.notEqual(result.status, 0);
      if (scenario === 'install-failure') assert.equal(result.calls.length, 1);
      else assert.match(result.stderr, /::error::/);
    });
  }
}
