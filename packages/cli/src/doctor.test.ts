import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  collectDoctorReport,
  collectDoctorReportAsync,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorText,
  isVersionAtLeast,
  parseDoctorArgs,
  parseRustVersion,
  type DoctorCommandResult,
  type DoctorMatrixRow,
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

/** NDK 경로가 환경 변수로 주입된 options — rn.android.ndk 를 통과시키기 위한 fixture. */
function optionsWithNdk(configPath: string, ndkHome: string): DoctorOptions {
  return { configPath, strict: false, platform: 'linux', env: { ANDROID_NDK_HOME: ndkHome } };
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

test('non-required failures do not fail the doctor command', () => {
  const report = {
    schemaVersion: 1 as const,
    checks: [{ id: 'optional', status: 'fail' as const, required: false, summary: 'optional' }],
  };
  assert.equal(doctorExitCode(report, false), 0);
  assert.equal(doctorExitCode(report, true), 0);
});

test('doctor probes identical native commands once per report', () => {
  withConfig(
    {
      schema: './generated/schema.json',
      output: './generated',
      reactNative: {},
      tauri: {},
    },
    (path) => {
      const calls: string[] = [];
      const runner: DoctorRunner = (command, args) => {
        calls.push([command, ...args].join(' '));
        return { ok: true, stdout: command === 'rustc' ? 'rustc 1.88.0' : '', stderr: '' };
      };
      collectDoctorReport(options(path, 'darwin'), runner);
      assert.equal(calls.filter((call) => call === 'xcodebuild -version').length, 1);
    },
  );
});

test('async doctor prefetches independent probes concurrently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-doctor-async-'));
  const path = join(root, 'rustra.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      reactNative: {},
      tauri: {},
    })}\n`,
  );
  let active = 0;
  let maximumActive = 0;
  const calls: string[] = [];
  try {
    await collectDoctorReportAsync(options(path, 'darwin'), async (command, args) => {
      calls.push([command, ...args].join(' '));
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return { ok: true, stdout: command === 'rustc' ? 'rustc 1.88.0' : '', stderr: '' };
    });
    assert.ok(maximumActive > 1);
    assert.equal(calls.filter((call) => call === 'xcodebuild -version').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.ok(
      !report.checks.some((check) => check.status === 'fail' && check.id.startsWith('rn.')),
    );
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
  assert.deepEqual(
    parseDoctorArgs(['--config', './app/rustra.json', '--format', 'json', '--strict']),
    {
      configPath: './app/rustra.json',
      format: 'json',
      strict: true,
    },
  );
});

// --- 다중 타깃 매트릭스 ---

/** 매트릭스 테스트용 프로젝트 fixture — rustra.json 외 파일도 함께 쓴다. */
function withProject(files: Record<string, string>, callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rustra-doctor-matrix-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CARGO_TOML =
  '[package]\nname = "app"\n\n[lib]\ncrate-type = ["rlib", "cdylib", "staticlib"]\n';

function metadataRunner(root: string, packages: Array<Record<string, unknown>>): DoctorRunner {
  return makeRunner({
    'rustc --version': { ok: true, stdout: 'rustc 1.88.0 (abc)', stderr: '' },
    'cargo --version': { ok: true, stdout: 'cargo 1.88.0', stderr: '' },
    'node --version': { ok: true, stdout: 'v20.0.0', stderr: '' },
    'bun --version': { ok: true, stdout: '1.4.0', stderr: '' },
    'c++ --version': { ok: true, stdout: 'Apple clang version 15.0.0', stderr: '' },
    'cmake --version': { ok: true, stdout: 'cmake version 3.29.0', stderr: '' },
    'pkg-config --version': { ok: true, stdout: 'pkg-config version 1.6.3', stderr: '' },
    'java -version': { ok: true, stdout: '', stderr: 'openjdk version "17.0.10"' },
    'adb version': { ok: true, stdout: 'Android Debug Bridge version 1.0.41', stderr: '' },
    'sdkmanager --version': { ok: true, stdout: '12.0', stderr: '' },
    'rustup target list --installed': {
      ok: true,
      stdout: 'aarch64-linux-android\nx86_64-linux-android\n',
      stderr: '',
    },
    [`cargo metadata --format-version 1 --no-deps --manifest-path ${join(root, 'Cargo.toml')}`]: {
      ok: true,
      stdout: JSON.stringify({ target_directory: root, packages }),
      stderr: '',
    },
    [`cargo metadata --format-version 1 --no-deps --manifest-path ${join(root, 'alt/Cargo.toml')}`]:
      {
        ok: true,
        stdout: JSON.stringify({
          target_directory: root,
          packages: [
            {
              name: 'alt',
              manifest_path: join(root, 'alt/Cargo.toml'),
              targets: [{ name: 'alt', crate_types: ['rlib', 'cdylib'] }],
            },
          ],
        }),
        stderr: '',
      },
  });
}

const HOST_SECTIONS = {
  codegen: { rustManifest: './Cargo.toml' },
  node: { rustManifest: './Cargo.toml' },
  bun: { rustManifest: './Cargo.toml', rustLibrary: 'app' },
  reactNative: { rustManifest: './Cargo.toml', rustLibrary: 'app' },
};

test('multi-section config collects a matrix row for every host section', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        ...HOST_SECTIONS,
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
      'ndk/source.properties': '',
    },
    (root) => {
      const report = collectDoctorReport(
        optionsWithNdk(join(root, 'rustra.json'), join(root, 'ndk')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      assert.ok(report.matrix, 'matrix should exist for 3 host sections');
      assert.deepEqual(
        report.matrix.rows.map((row) => row.target),
        ['node', 'bun', 'reactNative'],
      );
      for (const row of report.matrix.rows) {
        assert.equal(row.build, 'OK', `${row.target} build should be OK`);
        assert.equal(row.contract, 'OK', `${row.target} contract should be OK`);
        assert.equal(row.runtime, 'OK', `${row.target} runtime should be OK`);
        assert.equal(row.notes, '—');
      }
      assert.deepEqual(report.matrix.warnings, []);
    },
  );
});

test('a red section fails the run without aborting the other sections', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        ...HOST_SECTIONS,
        bun: { rustManifest: './Cargo.toml', rustLibrary: 'phantom_lib' },
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
      'ndk/source.properties': '',
    },
    (root) => {
      const report = collectDoctorReport(
        optionsWithNdk(join(root, 'rustra.json'), join(root, 'ndk')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      assert.ok(report.matrix);
      const bun = report.matrix.rows.find((row) => row.target === 'bun');
      assert.equal(bun?.build, 'FAIL');
      assert.match(bun?.notes ?? '', /rustLibrary missing/);
      // 다른 섹션은 여전히 수집·통과한다.
      for (const target of ['node', 'reactNative'] as const) {
        const row: DoctorMatrixRow | undefined = report.matrix.rows.find(
          (entry) => entry.target === target,
        );
        assert.equal(row?.build, 'OK', `${target} build should survive the bun failure`);
        assert.ok(report.checks.some((check) => check.id === `section.${target}.build`));
      }
      assert.equal(doctorExitCode(report, false), 1);
    },
  );
});

test('sections referencing different Rust manifests emit one consistency warning', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        ...HOST_SECTIONS,
        bun: { rustManifest: './alt/Cargo.toml', rustLibrary: 'alt' },
      }),
      'Cargo.toml': CARGO_TOML,
      'alt/Cargo.toml': '[package]\nname = "alt"\n\n[lib]\ncrate-type = ["rlib", "cdylib"]\n',
      'generated/schema.json': '{}\n',
      'ndk/source.properties': '',
    },
    (root) => {
      const report = collectDoctorReport(
        optionsWithNdk(join(root, 'rustra.json'), join(root, 'ndk')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      const consistency = report.checks.find((check) => check.id === 'config.rust_consistency');
      assert.equal(consistency?.status, 'warn');
      assert.match(consistency?.summary ?? '', /multiple Rust backends referenced/);
      assert.equal(report.matrix?.warnings.length, 1);
      // 경고 1줄이 텍스트 매트릭스에도 렌더된다.
      assert.match(formatDoctorText(report), /! multiple Rust backends referenced/);
      // 경고는 required 가 아니므로 non-strict 종료 코드는 0 이다.
      assert.equal(doctorExitCode(report, false), 0);
    },
  );
});

test('single-section config stays matrix-free for backward compatibility', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        node: { rustManifest: './Cargo.toml' },
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
    },
    (root) => {
      const report = collectDoctorReport(
        options(join(root, 'rustra.json')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      assert.equal(report.matrix, undefined);
      assert.ok(!formatDoctorText(report).includes('target '));
      // 섹션 검사 자체는 단일 섹션에서도 실행된다.
      assert.ok(report.checks.some((check) => check.id === 'section.node.build'));
      assert.equal(doctorExitCode(report, false), 0);
    },
  );
});

test('text formatter renders the matrix table', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        ...HOST_SECTIONS,
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
      'ndk/source.properties': '',
    },
    (root) => {
      const report = collectDoctorReport(
        optionsWithNdk(join(root, 'rustra.json'), join(root, 'ndk')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      const text = formatDoctorText(report);
      assert.match(text, /target\s+build\s+contract\s+runtime\s+notes/);
      assert.match(text, /node\s+OK\s+OK\s+OK\s+—/);
      assert.match(text, /reactNative\s+OK\s+OK\s+OK\s+—/);
    },
  );
});

test('async doctor prefetches per-section cargo metadata probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-doctor-matrix-async-'));
  const path = join(root, 'rustra.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      ...HOST_SECTIONS,
    })}\n`,
  );
  try {
    const report = await collectDoctorReportAsync(options(path), async (command, args) => ({
      ok: true,
      stdout:
        command === 'rustc'
          ? 'rustc 1.88.0'
          : command === 'cargo' && args[0] === 'metadata'
            ? JSON.stringify({
                target_directory: root,
                packages: [
                  {
                    name: 'app',
                    manifest_path: join(root, 'Cargo.toml'),
                    targets: [
                      { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
                      { name: 'generate', kind: ['bin'] },
                    ],
                  },
                ],
              })
            : '',
      stderr: '',
    }));
    assert.ok(report.matrix);
    assert.ok(
      !report.checks.some((check) => check.detail?.includes('probe was not prefetched')),
      'every matrix probe must be prefetched',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tauri matrix row has an em-dash build cell and a runtime cell driven by tauri.platform_tools', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        codegen: { rustManifest: './Cargo.toml' },
        node: { rustManifest: './Cargo.toml' },
        tauri: {},
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
    },
    (root) => {
      const report = collectDoctorReport(
        options(join(root, 'rustra.json')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      assert.ok(report.matrix, 'node+tauri is a 2-section config, so the matrix exists');
      assert.deepEqual(
        report.matrix.rows.map((row) => row.target),
        ['node', 'tauri'],
      );
      // tauri 섹션은 Rust 빌드 설정이 없다 — build 셀은 평가 대상이 아님('—').
      const tauri = report.matrix.rows.find((row) => row.target === 'tauri');
      assert.equal(tauri?.build, '—');
      assert.ok(!report.checks.some((check) => check.id === 'section.tauri.build'));
      // runtime 셀은 tauri.platform_tools 프리브 결과에 따른다 — id 변경 시 이 테스트가 red.
      assert.ok(
        report.checks.some((check) => check.id === 'tauri.platform_tools'),
        'runtime column must be driven by the tauri.platform_tools probe',
      );
      assert.equal(tauri?.runtime, 'OK');
      const failing = collectDoctorReport(
        options(join(root, 'rustra.json')),
        makeRunner({
          ...Object.fromEntries(
            [
              'rustc --version',
              'cargo --version',
              'node --version',
              'bun --version',
              'c++ --version',
              'cmake --version',
            ].map((probe) => [probe, { ok: true, stdout: 'ok', stderr: '' }]),
          ),
          [`cargo metadata --format-version 1 --no-deps --manifest-path ${join(root, 'Cargo.toml')}`]:
            {
              ok: true,
              stdout: JSON.stringify({
                target_directory: root,
                packages: [
                  {
                    name: 'app',
                    manifest_path: join(root, 'Cargo.toml'),
                    targets: [
                      { name: 'app', crate_types: ['rlib'] },
                      { name: 'generate', kind: ['bin'] },
                    ],
                  },
                ],
              }),
              stderr: '',
            },
          // tauri.platform_tools 프리브(linux 에서는 pkg-config --version)가 실패한다.
          'pkg-config --version': { ok: false, stdout: '', stderr: 'pkg-config missing' },
        }),
      );
      assert.equal(failing.matrix?.rows.find((row) => row.target === 'tauri')?.runtime, 'FAIL');
    },
  );
});

test('async doctor prefetches divergent section manifests without false prefetch failures', async () => {
  // bun 섹션만 codegen 매니페스트와 다른 alt/Cargo.toml 을 가리킨다 — 프리페치 루프의
  // 존재 이유를 검증하는 케이스 (모두 같은 매니페스트면 루프를 되돌려도 통과한다).
  const root = mkdtempSync(join(tmpdir(), 'rustra-doctor-matrix-divergent-'));
  const path = join(root, 'rustra.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      ...HOST_SECTIONS,
      bun: { rustManifest: './alt/Cargo.toml', rustLibrary: 'alt' },
    })}\n`,
  );
  writeFileSync(join(root, 'Cargo.toml'), CARGO_TOML);
  mkdirSync(join(root, 'alt'), { recursive: true });
  writeFileSync(
    join(root, 'alt/Cargo.toml'),
    '[package]\nname = "alt"\n\n[lib]\ncrate-type = ["rlib", "cdylib"]\n',
  );
  const probes: string[] = [];
  try {
    const report = await collectDoctorReportAsync(options(path), async (command, args) => {
      probes.push([command, ...args].join(' '));
      if (command === 'cargo' && args[0] === 'metadata') {
        const manifestPath = args[args.length - 1]!;
        const isAlt = manifestPath.endsWith('alt/Cargo.toml');
        return {
          ok: true,
          stdout: JSON.stringify({
            target_directory: root,
            packages: [
              {
                name: isAlt ? 'alt' : 'app',
                manifest_path: isAlt ? join(root, 'alt/Cargo.toml') : join(root, 'Cargo.toml'),
                targets: isAlt
                  ? [{ name: 'alt', crate_types: ['rlib', 'cdylib'] }]
                  : [
                      { name: 'app', crate_types: ['rlib', 'cdylib', 'staticlib'] },
                      { name: 'generate', kind: ['bin'] },
                    ],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { ok: true, stdout: command === 'rustc' ? 'rustc 1.88.0' : '', stderr: '' };
    });
    // (a) alt 매니페스트에 대한 cargo metadata 프리페치가 실제로 요청됐다.
    const altProbe = probes.find(
      (probe) => probe.startsWith('cargo metadata') && probe.endsWith('alt/Cargo.toml'),
    );
    assert.ok(altProbe, 'divergent bun manifest must be prefetched');
    // (b) bun build 검사는 프리페치 실패 오탈이 아니라 실제 판정(cdylib 발견)이다.
    const bunBuild = report.checks.find((check) => check.id === 'section.bun.build');
    assert.equal(bunBuild?.status, 'pass');
    assert.match(bunBuild?.summary ?? '', /cdylib alt/);
    assert.ok(
      !report.checks.some((check) => check.detail?.includes('probe was not prefetched')),
      'no probe-prefetch false FAIL anywhere in the report',
    );
    assert.ok(report.matrix);
    // bun 이 다른 매니페스트를 가리키므로 교차 일관성 경고가 1건 발생한다.
    assert.equal(report.matrix.warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── wasm dev 타깃 고지 (Task A3) ─────────────────────────────────────────────
//
// dev.target=wasm 은 협동형(단일스레드) 취소만 재현한다 — 동시성 버그(race/취소/
// 백프레셔)는 wasm dev 에서 절대 재현되지 않으므로 doctor 가 loud 경고해야 하고,
// wasm32 빌드 타깃 설치 여부도 필수 검사로 확인한다. 네이티브 타깃은 어느 쪽도
// 수집하지 않는다(절대 음성).

const WASM_DEV_CONFIG = {
  schema: './generated/schema.json',
  output: './generated',
  reactNative: { rustManifest: './Cargo.toml', rustLibrary: 'app' },
  dev: { target: 'wasm', wasm: { engine: 'wasm3' } },
};

test('wasm dev target warns about cooperative cancellation and checks the wasm32 rust target', () => {
  withProject(
    {
      'rustra.json': JSON.stringify(WASM_DEV_CONFIG),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
      // reactNative 섹션이 있어 Android 검사(NDK 포함)가 켜진다 — NDK fixture 로
      // 통과시켜 종료 코드 판정을 wasm 검사만으로 고립시킨다.
      'ndk/source.properties': '',
    },
    (root) => {
      const base = metadataRunner(root, [
        {
          name: 'app',
          manifest_path: join(root, 'Cargo.toml'),
          targets: [
            { name: 'app', crate_types: ['rlib', 'staticlib', 'cdylib'] },
            { name: 'generate', kind: ['bin'] },
          ],
        },
      ]);
      const runner: DoctorRunner = (command, args) => {
        if (command === 'rustup')
          return {
            ok: true,
            stdout: 'aarch64-linux-android\nx86_64-linux-android\nwasm32-unknown-unknown\n',
            stderr: '',
          };
        return base(command, args);
      };
      const report = collectDoctorReport(
        optionsWithNdk(join(root, 'rustra.json'), join(root, 'ndk')),
        runner,
      );
      const warning = report.checks.find((candidate) => candidate.id === 'dev.wasm.experimental');
      assert.equal(warning?.status, 'warn');
      assert.equal(warning?.required, false, 'the notice must not fail the doctor run');
      assert.match(
        warning?.summary ?? '',
        /협동형 취소만 유효 — 릴리스 전 native 검증 필수/,
        'the cancellation-gap notice must be loud in the summary',
      );
      assert.ok(
        !report.checks.some(
          (candidate) => candidate.id === 'dev.wasm.rust_target' && candidate.status === 'fail',
        ),
      );
      // warn 은 required 가 아니므로 non-strict 종료 코드는 0 이다.
      assert.equal(doctorExitCode(report, false), 0);
      // 텍스트 출력에도 고지가 렌더된다.
      assert.match(formatDoctorText(report), /협동형 취소만 유효/);
    },
  );
});

test('wasm dev target fails the required check when the wasm32 rust target is missing', () => {
  withProject(
    {
      'rustra.json': JSON.stringify(WASM_DEV_CONFIG),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
    },
    (root) => {
      const report = collectDoctorReport(
        options(join(root, 'rustra.json')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib', 'staticlib', 'cdylib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      const rustTarget = report.checks.find((candidate) => candidate.id === 'dev.wasm.rust_target');
      assert.equal(rustTarget?.status, 'fail', 'missing wasm32 target must fail a required check');
      assert.match(rustTarget?.summary ?? '', /wasm32-unknown-unknown/);
      assert.match((rustTarget?.fix ?? []).join(' '), /rustup target add wasm32-unknown-unknown/);
      // 필수 fail 이므로 non-strict 종료 코드는 1 — wasm32 없이 dev 를 진행하면 안 된다.
      assert.equal(doctorExitCode(report, false), 1);
    },
  );
});

test('native dev target emits neither the wasm notice nor the wasm32 target check', () => {
  withProject(
    {
      'rustra.json': JSON.stringify({
        schema: './generated/schema.json',
        output: './generated',
        node: { rustManifest: './Cargo.toml' },
      }),
      'Cargo.toml': CARGO_TOML,
      'generated/schema.json': '{}\n',
    },
    (root) => {
      const report = collectDoctorReport(
        options(join(root, 'rustra.json')),
        metadataRunner(root, [
          {
            name: 'app',
            manifest_path: join(root, 'Cargo.toml'),
            targets: [
              { name: 'app', crate_types: ['rlib'] },
              { name: 'generate', kind: ['bin'] },
            ],
          },
        ]),
      );
      assert.ok(
        !report.checks.some((candidate) => candidate.id.startsWith('dev.wasm')),
        'native target must not collect any wasm checks',
      );
    },
  );
});
