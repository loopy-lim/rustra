import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./ci-ios-crash-summary.mjs', import.meta.url));
const simId = '01234567-89ab-cdef-0123-456789abcdef';
const report = (extra = {}) => ({
  pid: 1234,
  procName: 'reactnativecalculator',
  captureTime: '2023-11-14 22:13:21.000 +0000',
  exception: { type: 'EXC_CRASH', signal: 'SIGABRT', codes: '0x0000000000000000' },
  termination: { namespace: 'SIGNAL', code: 6, indicator: 'Abort trap: 6' },
  faultingThread: 0,
  threads: [{ frames: [{ imageIndex: 0, imageOffset: 42, symbol: 'abort', symbolLocation: 7 }] }],
  usedImages: [{ name: 'libsystem_c.dylib', path: '/Users/private-owner/private-image' }],
  ...extra,
});

function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'rustra-ios-crash-'));
  const hostReports = join(home, 'Library/Logs/DiagnosticReports');
  const simReports = join(
    home,
    'Library/Developer/CoreSimulator/Devices',
    simId,
    'data/Library/Logs/CrashReporter',
  );
  const output = join(home, 'result.json');
  const put = (name, value, directory = hostReports) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const invoke = (
    args = ['--pid', '1234', '--started-at', '@1700000000', '--sim-id', simId, '--output', output],
  ) => {
    const result = spawnSync(
      process.execPath,
      [helper, ...args, '--reports-dir', hostReports, '--reports-dir', simReports],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    if (result.status !== 0) return { ...result };
    return { ...result, summary: JSON.parse(readFileSync(output, 'utf8')) };
  };
  try {
    run({ home, hostReports, simReports, output, put, invoke });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function successful(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.summary;
}

test('modern two-object IPS reports yield only the matching app crash fields', () =>
  fixture(({ put, invoke }) => {
    put(
      'reactnativecalculator-2023.ips',
      `${JSON.stringify({ bug_type: '309', timestamp: '2023-11-14 22:13:23 +0000' })}\n${JSON.stringify(report(), null, 2)}`,
    );
    const summary = successful(invoke());
    assert.equal(summary.status, 'found');
    assert.equal(summary.reports.length, 1);
    assert.deepEqual(summary.reports[0], {
      pid: 1234,
      procName: 'reactnativecalculator',
      captureTime: '2023-11-14T22:13:21.000Z',
      exception: { type: 'EXC_CRASH', signal: 'SIGABRT', codes: '0x0000000000000000' },
      termination: { namespace: 'SIGNAL', code: 6, indicator: 'Abort trap: 6' },
      faultingThread: {
        index: 0,
        frames: [
          { image: 'libsystem_c.dylib', imageOffset: 42, symbol: 'abort', symbolLocation: 7 },
        ],
      },
    });
    assert.ok(!JSON.stringify(summary).includes('private-owner'));
  }));

test('body-only JSON is found under this simulator and may match the exact launch instant', () =>
  fixture(({ put, simReports, invoke }) => {
    put(
      'reactnativecalculator.ips',
      report({ captureTime: '2023-11-14T22:13:20.000Z' }),
      simReports,
    );
    assert.equal(successful(invoke()).reports[0].captureTime, '2023-11-14T22:13:20.000Z');
  }));

for (const [name, extra] of [
  ['another PID', { pid: 5678 }],
  ['an old crash', { captureTime: '2023-11-14T22:13:19Z' }],
  ['another process', { procName: 'otherapp' }],
  ['missing capture time', { captureTime: undefined }],
  ['invalid capture time', { captureTime: 'not-a-date' }],
]) {
  test(`does not report ${name} even when metadata has a newer tracking timestamp`, () =>
    fixture(({ put, invoke }) => {
      put(
        'reactnativecalculator-2023.ips',
        `${JSON.stringify({ bug_type: '309', timestamp: '2026-10-03T00:00:00Z' })}\n${JSON.stringify(report(extra))}`,
      );
      const summary = successful(invoke());
      assert.equal(summary.status, 'no-report');
      assert.deepEqual(summary.reports, []);
    }));
}

test('other app filenames and non-crash IPS metadata are not reported', () =>
  fixture(({ put, invoke }) => {
    put('OtherApp-2023.ips', report());
    put(
      'reactnativecalculator-stackshot.ips',
      `${JSON.stringify({ bug_type: '288' })}\n${JSON.stringify(report())}`,
    );
    const summary = successful(invoke());
    assert.equal(summary.status, 'no-report');
    assert.equal(summary.scan.filesRead, 1);
  }));

test('missing directories and malformed reports produce explicit no-report without failing', () =>
  fixture(({ put, invoke }) => {
    assert.equal(successful(invoke()).status, 'no-report');
    put('reactnativecalculator-broken.ips', '{private malformed JSON');
    const result = invoke();
    const summary = successful(result);
    assert.equal(summary.status, 'no-report');
    assert.equal(summary.scan.parseErrors, 1);
    assert.ok(!JSON.stringify(summary).includes('private malformed'));
    assert.ok(!result.stderr.includes('private malformed'));
  }));

test('retains only the three newest matching occurrence times', () =>
  fixture(({ put, invoke }) => {
    for (const second of [25, 21, 24, 22, 23])
      put(
        `reactnativecalculator-${second}.ips`,
        report({ captureTime: `2023-11-14T22:13:${second}Z` }),
      );
    assert.deepEqual(
      successful(invoke()).reports.map((r) => r.captureTime),
      ['2023-11-14T22:13:25.000Z', '2023-11-14T22:13:24.000Z', '2023-11-14T22:13:23.000Z'],
    );
  }));

test('an oversized report is skipped before reading while another current report still works', () =>
  fixture(({ put, invoke }) => {
    put('reactnativecalculator-huge.ips', ' '.repeat(2 * 1024 * 1024 + 1));
    put('reactnativecalculator-small.ips', report());
    const summary = successful(invoke());
    assert.equal(summary.status, 'found');
    assert.equal(summary.scan.oversizedFiles, 1);
    assert.ok(summary.scan.bytesRead < 4096);
  }));

test('candidate file count and total bytes read stay bounded', () =>
  fixture(({ put, invoke }) => {
    for (let i = 0; i < 25; i++) put(`reactnativecalculator-${i}.ips`, report());
    const summary = successful(invoke());
    assert.ok(summary.scan.filesRead <= 20);
    assert.equal(summary.scan.limitReached, true);
    assert.ok(summary.reports.length <= 3);
  }));

test('directory enumeration is bounded even when unrelated files fill the report directory', () =>
  fixture(({ put, invoke }) => {
    for (let i = 0; i < 520; i++) put(`OtherApp-${i}.ips`, '{}');
    const summary = successful(invoke());
    assert.equal(summary.status, 'no-report');
    assert.ok(summary.scan.entriesExamined <= 512);
    assert.equal(summary.scan.filesRead, 0);
    assert.equal(summary.scan.limitReached, true);
  }));

test('aggregate byte budget prevents reading all individually valid large reports', () =>
  fixture(({ put, invoke }) => {
    for (let i = 0; i < 6; i++) {
      const body = JSON.stringify(report({ userInfo: 'x'.repeat(2 * 1024 * 1024 - 2048) }));
      put(`reactnativecalculator-${i}.ips`, body);
    }
    const summary = successful(invoke());
    assert.equal(summary.status, 'found');
    assert.ok(summary.scan.bytesRead <= 8 * 1024 * 1024);
    assert.ok(summary.scan.filesRead < 6);
    assert.equal(summary.scan.limitReached, true);
    assert.ok(JSON.stringify(summary).length < 16_000);
  }));

test('report symlinks cannot cause arbitrary source files to be read', () =>
  fixture(({ home, hostReports, invoke }) => {
    mkdirSync(hostReports, { recursive: true });
    const target = join(home, 'private-report.json');
    writeFileSync(target, JSON.stringify(report()));
    symlinkSync(target, join(hostReports, 'reactnativecalculator-link.ips'));
    const summary = successful(invoke());
    assert.equal(summary.status, 'no-report');
    assert.equal(summary.scan.filesRead, 0);
  }));

test('bounds faulting/exception frames and application diagnostics without copying private fields', () =>
  fixture(({ put, invoke }) => {
    const frames = Array.from({ length: 30 }, (_, i) => ({
      imageIndex: 0,
      imageOffset: i,
      symbol: 'f'.repeat(400),
      symbolLocation: i,
      path: '/Users/private-owner/file',
    }));
    put(
      'reactnativecalculator-private.ips',
      report({
        procPath: '/Users/private-owner/app',
        userInfo: 'private-user-info',
        env: { TOKEN: 'private-env' },
        exception: { type: 'EXC_CRASH', signal: 'SIGABRT', message: 'private-exception-message' },
        threads: [{ queue: 'private-queue', threadState: 'private-registers', frames }],
        usedImages: [
          {
            name: '/Users/private-owner/libsystem_c.dylib',
            path: '/Users/private-owner/private-image',
          },
        ],
        lastExceptionBacktrace: frames,
        asi: {
          CoreFoundation: [
            "Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: 'missing CallInvoker'",
            '/Users/private-owner/file /opt/private-report TOKEN=private-token https://private.example/path',
            'a'.repeat(800),
          ],
          'libc++abi': ['terminating due to uncaught exception', 'must-not-fit'],
          unknown: ['private-unknown-asi'],
        },
      }),
    );
    const summary = successful(invoke());
    const crash = summary.reports[0];
    assert.equal(crash.faultingThread.frames.length, 12);
    assert.equal(crash.lastExceptionBacktrace.length, 12);
    assert.equal(crash.applicationSpecificInformation.length, 4);
    assert.match(crash.applicationSpecificInformation[0].message, /missing CallInvoker/);
    for (const line of crash.applicationSpecificInformation) assert.ok(line.message.length <= 300);
    for (const frame of crash.faultingThread.frames) assert.ok(frame.symbol.length <= 300);
    const encoded = JSON.stringify(summary);
    for (const privateText of [
      'private-owner',
      '/opt/private-report',
      'private-user-info',
      'private-env',
      'private-token',
      'private.example',
      'private-exception-message',
      'private-queue',
      'private-registers',
      'private-unknown-asi',
      'must-not-fit',
    ])
      assert.ok(!encoded.includes(privateText), privateText);
  }));

test('malformed optional diagnostic fields are ignored without exposing their raw contents', () =>
  fixture(({ put, invoke }) => {
    put(
      'reactnativecalculator-odd.ips',
      report({
        faultingThread: -1,
        lastExceptionBacktrace: 'private-backtrace',
        asi: { libc: { private: 'private-asi' } },
      }),
    );
    const summary = successful(invoke());
    assert.equal(summary.status, 'found');
    assert.ok(!JSON.stringify(summary).includes('private-'));
  }));

test('application diagnostics redact credentials encoded as quoted JSON or authentication headers', () =>
  fixture(({ put, invoke }) => {
    put(
      'reactnativecalculator-credentials.ips',
      report({
        asi: {
          'libc++abi.dylib': [
            '{"TOKEN":"private-json-token","PASSWORD":"private-json-password","API_KEY":"private-json-key"}',
            "{'SECRET': 'private-quoted-secret'}",
            'Authorization: Bearer private-bearer-value',
            '{"Authorization":"Basic private-basic-value"}',
          ],
        },
      }),
    );
    const summary = successful(invoke());
    assert.equal(summary.reports[0].applicationSpecificInformation.length, 4);
    const encoded = JSON.stringify(summary);
    for (const value of [
      'private-json-token',
      'private-json-password',
      'private-json-key',
      'private-quoted-secret',
      'private-bearer-value',
      'private-basic-value',
    ])
      assert.ok(!encoded.includes(value), value);
  }));

test('invalid PID, timestamp or simulator identifier fail without scanning or echoing argument data', () =>
  fixture(({ output, invoke }) => {
    for (const args of [
      ['--pid', '0', '--started-at', '@1700000000', '--sim-id', simId, '--output', output],
      ['--pid', '1234', '--started-at', 'private-bad-time', '--sim-id', simId, '--output', output],
      [
        '--pid',
        '1234',
        '--started-at',
        '@1700000000',
        '--sim-id',
        '../private-path',
        '--output',
        output,
      ],
    ]) {
      const result = invoke(args);
      assert.equal(result.status, 2, result.stderr);
      assert.ok(!result.stderr.includes('private-'));
    }
  }));
