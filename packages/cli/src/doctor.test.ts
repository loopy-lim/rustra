import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectDoctorReport,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorText,
  isVersionAtLeast,
  parseDoctorArgs,
  parseRustVersion,
  type DoctorCommandResult,
  type DoctorOptions,
  type DoctorRunner,
} from './doctor.js';

function makeRunner(results: Record<string, DoctorCommandResult>): DoctorRunner {
  return (command, args) =>
    results[[command, ...args].join(' ')] ?? {
      ok: false,
      stdout: '',
      stderr: `${command} not configured in test runner`,
    };
}

function withConfig(config: Record<string, unknown>, callback: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rustra-doctor-'));
  const path = join(root, 'rustra.json');
  writeFileSync(path, `${JSON.stringify(config)}\n`);
  try {
    callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function options(configPath: string, platform: NodeJS.Platform = 'linux'): DoctorOptions {
  return { configPath, strict: false, platform, env: {} };
}

test('Rust 1.88 satisfies the MSRV and Rust 1.87 fails', () => {
  assert.deepEqual(parseRustVersion('rustc 1.88.0 (abc)'), [1, 88, 0]);
  assert.equal(isVersionAtLeast([1, 88, 0], [1, 88, 0]), true);
  assert.equal(isVersionAtLeast([1, 87, 9], [1, 88, 0]), false);
  assert.equal(parseRustVersion('unknown'), null);
});

test('strict mode promotes warnings to a failing exit code', () => {
  const report = {
    schemaVersion: 1 as const,
    checks: [{ id: 'optional', status: 'warn' as const, required: false, summary: 'warn' }],
  };
  assert.equal(doctorExitCode(report, false), 0);
  assert.equal(doctorExitCode(report, true), 1);
});

test('Node/Bun-only config does not require RN platform tools', () => {
  withConfig({ schema: './generated/schema.json', output: './generated', node: {} }, (path) => {
    const report = collectDoctorReport(
      options(path),
      makeRunner({
        'rustc --version': { ok: true, stdout: 'rustc 1.88.0 (abc)', stderr: '' },
        'cargo --version': { ok: true, stdout: 'cargo 1.88.0', stderr: '' },
        'node --version': { ok: true, stdout: 'v20.0.0', stderr: '' },
        'cargo metadata --format-version 1 --no-deps --manifest-path': {
          ok: false,
          stdout: '',
          stderr: 'test runner does not match path suffix',
        },
      }),
    );

    assert.ok(!report.checks.some((check) => check.id.startsWith('rn.')));
    assert.ok(!report.checks.some((check) => check.status === 'fail' && check.id.startsWith('rn.')));
  });
});

test('missing Android NDK reports the pinned version and an actionable fix', () => {
  withConfig(
    { schema: './generated/schema.json', output: './generated', reactNative: {} },
    (path) => {
      const report = collectDoctorReport(
        options(path),
        makeRunner({
          'rustc --version': { ok: true, stdout: 'rustc 1.88.0 (abc)', stderr: '' },
          'cargo --version': { ok: true, stdout: 'cargo 1.88.0', stderr: '' },
          'node --version': { ok: true, stdout: 'v20.0.0', stderr: '' },
          'xcodebuild -version': { ok: false, stdout: '', stderr: 'not macOS' },
          'pod --version': { ok: false, stdout: '', stderr: 'missing' },
          'java -version': { ok: true, stdout: '', stderr: 'openjdk version "17.0.10"' },
          'adb version': { ok: true, stdout: 'Android Debug Bridge version 1.0.41', stderr: '' },
          'sdkmanager --version': { ok: true, stdout: '12.0', stderr: '' },
          'rustup target list --installed': {
            ok: true,
            stdout: 'aarch64-linux-android\nx86_64-linux-android\n',
            stderr: '',
          },
        }),
      );
      const ndk = report.checks.find((check) => check.id === 'rn.android.ndk');
      assert.equal(ndk?.status, 'fail');
      assert.match(ndk?.summary ?? '', /27\.1\.12297006/);
      assert.ok(ndk?.fix?.some((line) => line.includes('sdkmanager')));
    },
  );
});

test('doctor formatters expose stable JSON and readable fixes', () => {
  const report = {
    schemaVersion: 1 as const,
    checks: [
      {
        id: 'rustc.msrv',
        status: 'pass' as const,
        required: true,
        summary: 'Rust 1.88.0 satisfies MSRV 1.88',
      },
      {
        id: 'rn.android.ndk',
        status: 'fail' as const,
        required: true,
        summary: 'Android NDK 27.1.12297006 is missing',
        fix: ['sdkmanager "ndk;27.1.12297006"'],
      },
    ],
  };
  assert.deepEqual(JSON.parse(formatDoctorJson(report)), report);
  assert.match(formatDoctorText(report), /PASS rustc\.msrv/);
  assert.match(formatDoctorText(report), /fix: sdkmanager/);
});

test('doctor args default to rustra.json and text output', () => {
  assert.deepEqual(parseDoctorArgs([]), {
    configPath: 'rustra.json',
    format: 'text',
    strict: false,
  });
  assert.deepEqual(parseDoctorArgs(['--config', './app/rustra.json', '--format', 'json', '--strict']), {
    configPath: './app/rustra.json',
    format: 'json',
    strict: true,
  });
});
