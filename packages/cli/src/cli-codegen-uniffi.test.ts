// uniffi 코드젠 단계의 스폰 계약 e2e — uniffi 섹션이 있을 때 codegen 이 스폰하는
// cargo 명령열(프로브 → cdylib build → uniffi-bindgen)과 env(RUSTRA_UNIFFI_OUT),
// 그리고 check 모드의 비대칭(러스트 재빌드 없이 uniffi_generated.rs 바이트 비교만)을
// 고정한다. uniffi 섹션이 없는 프로젝트는 스폰열이 이전과 동일해야 한다(기능 스위치
// 의계약 — 무음 회귀를 여기서 잡는다).
//
// cargo 는 cli-codegen-json.test.ts 의 fake 스크립트 패턴을 따른다(metadata →
// generate/uniffi-bindgen bin 보고, run → 산출물 기록). 실제 cargo 빌드는 하지 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodegen } from './cli-codegen.js';
import {
  UNIFFI_GENERATED_RS,
  assertBindingOutputs,
  checkUniffiGeneratedRs,
  expectedDylibPath,
  resolveUniffiSrcOut,
} from './cli-uniffi.js';

const FAKE_BIN = 'fake-cargo-bin';

const SCHEMA = {
  packageId: 'app.uniffi',
  commands: [
    {
      name: 'echo',
      inputType: 'EchoInput',
      outputType: 'EchoOutput',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
};

type SeedOptions = {
  /** uniffi 섹션 — 생략하면 기능 스위치가 꺼진(무 uniffi) 프로젝트가 된다. */
  uniffi?: Record<string, unknown>;
};

function seedProject(root: string, options: SeedOptions = {}): string {
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'generated'), { recursive: true });
  mkdirSync(join(root, FAKE_BIN), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(
    join(project, 'rustra.json'),
    JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      codegen: { rustManifest: './Cargo.toml', rustPackage: 'x', rustBinary: 'generate' },
      ...(options.uniffi ? { uniffi: options.uniffi } : {}),
    }),
  );
  writeFileSync(join(root, 'schema.json'), JSON.stringify(SCHEMA));
  const fakeCargo = [
    '#!/bin/bash',
    '# 스파이 — 모든 호출의 첫 서브커맨드와 프로브 env 를 기록한다.',
    'echo "$1 | RUO=${RUSTRA_UNIFFI_OUT:-}" >> "$FAKE_CARGO_LOG"',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '"targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]},',
    '{"name":"custom_bridge","crate_types":["cdylib"],"kind":["cdylib"]},',
    '{"name":"uniffi-bindgen","crate_types":["bin"],"kind":["bin"]}]}]}\\n\' "$dir" "$manifest"',
    '  exit 0',
    'fi',
    'if [ "$1" = "run" ]; then',
    '  bin=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--bin" ] && bin="$a"; prev="$a"; done',
    '  if [ "$bin" = "generate" ]; then',
    '    mkdir -p "$RUSTRA_SCHEMA_OUT"',
    '    cp "$FAKE_SCHEMA_FILE" "$RUSTRA_SCHEMA_OUT/schema.json"',
    '    if [ -n "$RUSTRA_UNIFFI_OUT" ]; then',
    '      mkdir -p "$RUSTRA_UNIFFI_OUT"',
    '      printf \'// uniffi mirror probe\\n\' > "$RUSTRA_UNIFFI_OUT/uniffi_generated.rs"',
    '    fi',
    '    exit 0',
    '  fi',
    '  if [ "$bin" = "uniffi-bindgen" ]; then',
    '    host=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--target" ] && host="$a"; prev="$a"; done',
    '    if [ -z "$host" ] || [ "$host" = "mobile-triple" ]; then echo "bindgen must use host --target" >&2; exit 4; fi',
    '    if [ -n "$FAKE_BINDGEN_EMPTY" ]; then exit 0; fi',
    '    if [ -n "$FAKE_BINDGEN_FAIL" ]; then echo "bindgen exploded" >&2; exit 3; fi',
    '    outdir=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--out-dir" ] && outdir="$a"; prev="$a"; done',
    '    mkdir -p "$outdir/kotlin" "$outdir/swift"',
    '    echo "fun bridge() {}" > "$outdir/kotlin/bridge.kt"',
    '    echo "func bridge() {}" > "$outdir/swift/bridge.swift"',
    '    echo "void bridge(void);" > "$outdir/swift/bridge.h"',
    '    echo "module bridge { }" > "$outdir/swift/module.modulemap"',
    '    exit 0',
    '  fi',
    'fi',
    'if [ "$1" = "build" ]; then',

    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  mkdir -p "$dir/custom-target/mobile-triple/debug"',
    '  artifact="$dir/custom-target/mobile-triple/debug/libcustom_bridge.so"',
    '  if [ -z "$FAKE_SKIP_DYLIB" ]; then echo dylib > "$artifact"; fi',
    '  printf \'{"reason":"compiler-artifact","target":{"name":"custom_bridge","kind":["cdylib"]},"filenames":["%s"]}\\n\' "$artifact"',
    '  exit 0',
    'fi',
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
  return project;
}

type TestEnv = {
  project: string;
  logPath: string;
  restore: () => void;
};

/**
 * fake cargo 를 PATH 에 올리고 콘솔 출력을 가둔다 — 기존 codegen 테스트와 같은
 * 자원원복(one restore) 계약. env 스위치(FAKE_BINDEN_FAIL 등)는 spawnInherit 이
 * process.env 를 상속하므로 그대로 아래 자식에게 닿는다.
 */
function withFakeCargo(root: string, options: SeedOptions = {}): TestEnv {
  const project = seedProject(root, options);
  const logPath = join(root, 'cargo-spy.log');
  const originalPath = process.env.PATH;
  const originalLog = console.log;
  const originalError = console.error;
  process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
  process.env.FAKE_SCHEMA_FILE = join(root, 'schema.json');
  process.env.FAKE_CARGO_LOG = logPath;
  delete process.env.FAKE_BINDGEN_FAIL;
  delete process.env.FAKE_SKIP_DYLIB;
  delete process.env.FAKE_BINDGEN_EMPTY;
  console.log = () => {};
  console.error = () => {};
  return {
    project,
    logPath,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      process.env.PATH = originalPath;
      delete process.env.FAKE_SCHEMA_FILE;
      delete process.env.FAKE_CARGO_LOG;
      delete process.env.FAKE_BINDGEN_FAIL;
      delete process.env.FAKE_SKIP_DYLIB;
      delete process.env.FAKE_BINDGEN_EMPTY;
    },
  };
}

/** 스파이 로그를 서브커맨드열로 — 스폰 순서 단언 전용. */
function spawnSequence(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(' | ')[0]!);
}

test('uniffi-configured codegen spawns probe → cdylib build → bindgen and writes bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-run-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  try {
    await runCodegen(['--config', join(env.project, 'rustra.json')]);
    // 스폰열: metadata(resolveCodegenTarget) → run(generate 프로브) → build →
    // run(uniffi-bindgen). TS 렌더는 cargo 를 스폰하지 않는다.
    assert.deepEqual(spawnSequence(env.logPath), ['metadata', 'run', 'build', 'run']);
    // 프로브 env — RUSTRA_UNIFFI_OUT 은 커밋 위치(uniffi.srcOut 기본 "src")를 가리킨다.
    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, new RegExp(`run \\| RUO=${join(env.project, 'src').replace(/\\/g, '\\\\')}`));
    // 프로브가 커밋 위치에 uniffi_generated.rs 를 썼다.
    assert.ok(
      existsSync(join(env.project, 'src', UNIFFI_GENERATED_RS)),
      'probe must write the committed uniffi_generated.rs',
    );
    // bindgen 이 uniffi.output 에 Kotlin/Swift 바인딩을 썼다.
    const bindingDir = join(env.project, 'bindings', 'uniffi');
    assert.ok(existsSync(join(bindingDir, 'kotlin', 'bridge.kt')));
    assert.ok(existsSync(join(bindingDir, 'swift', 'bridge.swift')));
    assert.ok(existsSync(join(bindingDir, 'swift', 'module.modulemap')));
    // TS 렌더도 이전과 같이 흘렀다.
    assert.ok(existsSync(join(env.project, 'generated', 'types.ts')));
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('uniffi codegen --check only byte-compares uniffi_generated.rs and never builds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-check-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  try {
    // 1차 — 쓰기 코드젠으로 커밋 산출물(src/uniffi_generated.rs + manifest)을 만든다.
    await runCodegen(['--config', join(env.project, 'rustra.json')]);
    writeFileSync(env.logPath, '');
    // 2차 — check 모드. cargo build/bindgen 스폰이 없어야 한다(비대칭 계약).
    await runCodegen(['--config', join(env.project, 'rustra.json'), '--check']);
    // metadata 스폰은 cargo-metadata 캐시(mtime+size)로 흡수될 수 있으니 숫자가
    // 아니라 부재로 단언한다 — build 가 없고 run(generate 프로브)이 정확히 1회.
    const checkSeq = spawnSequence(env.logPath);
    assert.ok(
      !checkSeq.includes('build'),
      `check mode must not spawn cargo build, got: ${JSON.stringify(checkSeq)}`,
    );
    assert.equal(
      checkSeq.filter((cmd) => cmd === 'run').length,
      1,
      `only the schema probe runs in check mode, got: ${JSON.stringify(checkSeq)}`,
    );
    // bindgen 출력 디렉터리도 건드리지 않았다(쓰기 산출물 재검증은 안 함).
    // 3차 — 커밋 파일 변조 → 드리프트로 실패하고 재생성 안내를 낸다.
    const committed = join(env.project, 'src', UNIFFI_GENERATED_RS);
    writeFileSync(committed, readFileSync(committed, 'utf8') + '\n// drift probe\n');
    await assert.rejects(
      () => runCodegen(['--config', join(env.project, 'rustra.json'), '--check']),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /uniffi drift \(disk changed\)/);
        assert.match(message, /Run rustra codegen/);
        return true;
      },
    );
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('check mode fails closed when the committed uniffi_generated.rs is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-miss-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  try {
    await runCodegen(['--config', join(env.project, 'rustra.json')]);
    rmSync(join(env.project, 'src', UNIFFI_GENERATED_RS));
    writeFileSync(env.logPath, '');
    await assert.rejects(
      () => runCodegen(['--config', join(env.project, 'rustra.json'), '--check']),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /uniffi drift \(missing\)/);
        assert.match(message, /Run rustra codegen/);
        return true;
      },
    );
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindgen failure exits non-zero with the wrapped context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-bindfail-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  process.env.FAKE_BINDGEN_FAIL = '1';
  try {
    await assert.rejects(
      () => runCodegen(['--config', join(env.project, 'rustra.json')]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /uniffi-bindgen failed for x/);
        assert.match(message, /exit 3/);
        return true;
      },
    );
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing cdylib after the build step is a clear fail-closed error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-nolib-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  process.env.FAKE_SKIP_DYLIB = '1';
  try {
    await assert.rejects(
      () => runCodegen(['--config', join(env.project, 'rustra.json')]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /did not produce .*libcustom_bridge\.so/);
        assert.match(message, /crate-type/);
        return true;
      },
    );
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('projects without a uniffi section keep the pre-uniffi spawn sequence byte-for-byte', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-off-'));
  const env = withFakeCargo(root);
  try {
    await runCodegen(['--config', join(env.project, 'rustra.json')]);
    // metadata + 프로브 스폰뿐 — build/bindgen 가 새는 없다.
    assert.deepEqual(spawnSequence(env.logPath), ['metadata', 'run']);
    // 프로브에 RUSTRA_UNIFFI_OUT 을 흘리지 않는다(env 미설정 = RUO 빈 문자열).
    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /^run \| RUO=$/m);
    assert.ok(!existsSync(join(env.project, 'src', UNIFFI_GENERATED_RS)));
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli-uniffi helpers: dylib naming, output completeness, and drift comparison', async () => {
  // 플랫폼별 cdylib 파일명 관례 — 하이픈은 밑줄로.
  const dylib = expectedDylibPath('/tgt', 'rustra-calculator-example', 'debug');
  if (process.platform === 'darwin')
    assert.equal(dylib, join('/tgt', 'debug', 'librustra_calculator_example.dylib'));
  else if (process.platform === 'linux')
    assert.equal(dylib, join('/tgt', 'debug', 'librustra_calculator_example.so'));
  else if (process.platform === 'win32')
    assert.equal(dylib, join('/tgt', 'debug', 'rustra_calculator_example.dll'));

  // srcOut 기본값은 config 파일 디렉터리 기준 "src".
  assert.equal(resolveUniffiSrcOut('/cfg', { output: './b' }), join('/cfg', 'src'));
  assert.equal(
    resolveUniffiSrcOut('/cfg', { output: './b', srcOut: 'rust-src' }),
    join('/cfg', 'rust-src'),
  );

  // 산출물 완전성 — 4요소(.kt/.swift/.h/modulemap)가 모이면 통과.
  const outDir = mkdtempSync(join(tmpdir(), 'rustra-uniffi-outs-'));
  try {
    mkdirSync(join(outDir, 'kotlin'), { recursive: true });
    mkdirSync(join(outDir, 'swift'), { recursive: true });
    writeFileSync(join(outDir, 'kotlin', 'a.kt'), '');
    assert.throws(() => assertBindingOutputs(outDir), /incomplete/);
    writeFileSync(join(outDir, 'swift', 'a.swift'), '');
    assert.throws(() => assertBindingOutputs(outDir), /incomplete/);
    writeFileSync(join(outDir, 'swift', 'a.h'), '');
    assert.throws(() => assertBindingOutputs(outDir), /incomplete/);
    writeFileSync(join(outDir, 'swift', 'module.modulemap'), '');
    assert.doesNotThrow(() => assertBindingOutputs(outDir));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  // 신선도 비교 — 동일 바이트는 통과, 변조는 drift, 커밋 부재는 missing,
  // 프로브 무출력은 RUSTRA_UNIFFI_OUT 계약 위반.
  const cmp = mkdtempSync(join(tmpdir(), 'rustra-uniffi-cmp-'));
  try {
    const tempRs = join(cmp, 'temp', UNIFFI_GENERATED_RS);
    const committedRs = join(cmp, 'committed', UNIFFI_GENERATED_RS);
    mkdirSync(join(cmp, 'temp'), { recursive: true });
    mkdirSync(join(cmp, 'committed'), { recursive: true });
    writeFileSync(tempRs, '// mirror\n');
    await assert.rejects(
      () => checkUniffiGeneratedRs(tempRs, committedRs),
      /uniffi drift \(missing\)/,
    );
    writeFileSync(committedRs, '// mirror\n');
    await checkUniffiGeneratedRs(tempRs, committedRs);
    writeFileSync(committedRs, '// mirror v2\n');
    await assert.rejects(
      () => checkUniffiGeneratedRs(tempRs, committedRs),
      /uniffi drift \(disk changed\)/,
    );
    await assert.rejects(
      () => checkUniffiGeneratedRs(join(cmp, 'absent.rs'), committedRs),
      /must honor RUSTRA_UNIFFI_OUT in check mode/,
    );
  } finally {
    rmSync(cmp, { recursive: true, force: true });
  }
});

test('config dev reloads paths from atomically replaced rustra.json and watches new sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-refresh-'));
  const env = withFakeCargo(root);
  let handle: { dispose(): void } | undefined;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
    assert.ok(predicate(), 'dev failed to refresh configuration/sources');
  };
  try {
    const { runDev } = await import('./dev.js');
    const { renameSync } = await import('node:fs');
    const configPath = join(env.project, 'rustra.json');
    handle = await runDev(['--config', configPath]);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.output = './next-generated';
    config.schema = './next-generated/schema.json';
    writeFileSync(`${configPath}.tmp`, JSON.stringify(config));
    renameSync(`${configPath}.tmp`, configPath);
    await waitFor(() => existsSync(join(env.project, 'next-generated', 'types.ts')));
    writeFileSync(env.logPath, '');
    mkdirSync(join(env.project, 'src', 'new'), { recursive: true });
    writeFileSync(join(env.project, 'src', 'new', 'lib.rs'), 'fn new_source() {}');
    await waitFor(() => spawnSequence(env.logPath).includes('run'));
  } finally {
    handle?.dispose();
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty bindgen output cannot reuse old bindings and failure preserves the published tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-empty-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  try {
    await runCodegen(['--config', join(env.project, 'rustra.json')]);
    const swift = join(env.project, 'bindings/uniffi/swift/bridge.swift');
    const before = readFileSync(swift, 'utf8');
    process.env.FAKE_BINDGEN_EMPTY = '1';
    await assert.rejects(
      () => runCodegen(['--config', join(env.project, 'rustra.json')]),
      /incomplete/,
    );
    assert.equal(readFileSync(swift, 'utf8'), before);
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check-bindings detects actual Swift/Kotlin and extra-file drift without overwriting them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-drift-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  try {
    const args = ['--config', join(env.project, 'rustra.json')];
    await runCodegen(args);
    await runCodegen([...args, '--check-bindings']);
    const binding = join(env.project, 'bindings/uniffi/kotlin/bridge.kt');
    const clean = readFileSync(binding, 'utf8');
    writeFileSync(binding, 'tampered Kotlin');
    await assert.rejects(() => runCodegen([...args, '--check-bindings']), /binding drift/);
    assert.equal(readFileSync(binding, 'utf8'), 'tampered Kotlin');
    writeFileSync(binding, clean);
    const stale = join(env.project, 'bindings/uniffi/swift/stale.swift');
    writeFileSync(stale, 'stale');
    await assert.rejects(() => runCodegen([...args, '--check-bindings']), /binding drift/);
    await runCodegen(args);
    assert.equal(existsSync(stale), false, 'successful publish removes stale bindings');
  } finally {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('config dev does not treat its generated UniFFI Rust mirror as a new source change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-uniffi-self-'));
  const env = withFakeCargo(root, { uniffi: { output: './bindings/uniffi' } });
  let handle: { dispose(): void } | undefined;
  try {
    const { runDev } = await import('./dev.js');
    handle = await runDev(['--config', join(env.project, 'rustra.json')]);
    const before = readFileSync(env.logPath, 'utf8');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(
      readFileSync(env.logPath, 'utf8'),
      before,
      'generated mirror must not start another run',
    );
  } finally {
    handle?.dispose();
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping binding output is rejected before probe or any existing file changes', async () => {
  for (const output of ['./generated', '.', './src']) {
    const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-overlap-'));
    const env = withFakeCargo(root, { uniffi: { output } });
    try {
      const schema = join(env.project, 'generated/schema.json');
      mkdirSync(join(env.project, 'generated'), { recursive: true });
      writeFileSync(schema, 'user sentinel');
      const source = join(env.project, 'src/lib.rs');
      writeFileSync(source, 'source sentinel');
      await assert.rejects(
        runCodegen(['--config', join(env.project, 'rustra.json')]),
        /dedicated.*binding|binding.*overlap/,
      );
      assert.equal(readFileSync(schema, 'utf8'), 'user sentinel');
      assert.equal(readFileSync(source, 'utf8'), 'source sentinel');
      assert.equal(
        spawnSequence(env.logPath).filter((value) => value === 'run' || value === 'build').length,
        0,
      );
    } finally {
      env.restore();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('bindings inside src do not trigger their own dev rebuild loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-uniffi-self-watch-'));
  const env = withFakeCargo(root, { uniffi: { output: './src/bindings' } });
  let handle: { dispose(): void } | undefined;
  try {
    const { runDev } = await import('./dev.js');
    handle = await runDev(['--config', join(env.project, 'rustra.json')]);
    const builds = () => spawnSequence(env.logPath).filter((value) => value === 'build').length;
    const initial = builds();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(builds(), initial, 'native binding/staging writes must remain idle');
    writeFileSync(join(env.project, 'src/changed.rs'), 'fn changed() {}');
    const deadline = Date.now() + 3000;
    while (builds() === initial && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(builds(), initial + 1, 'actual Rust source must still trigger a build');
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(builds(), initial + 1);
  } finally {
    handle?.dispose();
    env.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
