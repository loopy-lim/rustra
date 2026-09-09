import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDylibCore,
  liveArtifactPath,
  pickCdylibArtifact,
  publishGatedArtifact,
} from './dev-dylib.js';
import { readDevConfig } from './dev-config.js';
import type { ResolvedDevDylib } from './dev-config.js';

// ── buildDylibCore — dylib dev 타깃 빌드 헬퍼 ────────────────────────────────
//
// cargo 는 PATH 앞단의 fake 스크립트로 대체한다(dev-parity-wiring.test.ts 와 같은
// 방식). 핀 두 가지:
//   (i)   cargo build 는 --manifest-path [-p] --lib --message-format=json 이어야
//         한다 — stdout JSON 의 compiler-artifact 메시지가 산출물 경로의 유일한
//         근원이므로(계산이 아니다).
//   (ii)  cdylib artifact 메시지가 없으면 loud 실패 — crate-type "cdylib" 선언
//         힌트를 함께 말해야 한다(조용한 스킵/재시도 없음).

const FAKE_BIN = 'fake-cargo-bin';

/** 호스트 플랫폼이 받을 fake cdylib 파일명 — cargo 확장자 규약(lib 접두어 포함). */
function hostArtifactName(libName: string): string | undefined {
  if (process.platform === 'darwin') return `lib${libName}.dylib`;
  if (process.platform === 'linux') return `lib${libName}.so`;
  if (process.platform === 'win32') return `${libName}.dll`;
  return undefined;
}

type MetadataVariant = 'default' | 'no-cdylib';

/**
 * fake cargo — metadata 는 단일 패키지 x(generate bin + rustra_bridge lib)를
 * 말하고, build 는 compiler-artifact JSON 줄을 stdout 에 낸다. 변형:
 *  - FAKE_BUILD_LOG: 빌드 인수 기록(플래그 핀 검증용)
 *  - FAKE_BUILD_FAIL: 비정상 종료(에러 래핑 검증용)
 *  - FAKE_NO_CDYLIB_MSG: cdylib 없이 rmeta 만 통과(산출물 부재 loud 실패 검증용)
 *  - FAKE_TWO_MESSAGES: 오래된 cdylib 메시지를 먼저 흘린다(최신 메시지 우선 핀)
 *  - FAKE_METADATA=no-cdylib: metadata 의 lib 타깃에서 cdylib 를 뺀다
 */
function seedFakeCargo(root: string, metadataVariant: MetadataVariant = 'default'): void {
  mkdirSync(join(root, FAKE_BIN), { recursive: true });
  const crateTypes = metadataVariant === 'no-cdylib' ? '["staticlib"]' : '["staticlib","cdylib"]';
  const fakeCargo = [
    '#!/bin/bash',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '"targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]},',
    `{"name":"rustra_bridge","crate_types":${crateTypes},"kind":["lib"]}]}]}\\n' "$dir" "$manifest"`,
    '  exit 0',
    'fi',
    'if [ "$1" = "build" ]; then',
    '  [ -n "$FAKE_BUILD_LOG" ] && printf \'%s\\n\' "$*" >> "$FAKE_BUILD_LOG"',
    '  if [ -n "$FAKE_BUILD_FAIL" ]; then echo "fake dylib build failure" >&2; exit 4; fi',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  out="$dir/target/debug"',
    '  mkdir -p "$out"',
    '  if [ -n "$FAKE_NO_CDYLIB_MSG" ]; then',
    '    printf \'%s\\n\' "{\\"reason\\":\\"compiler-artifact\\",\\"filenames\\":[\\"$out/librustra_bridge.rmeta\\"],\\"target\\":{\\"kind\\":[\\"lib\\"]}}"',
    '    exit 0',
    '  fi',
    '  if [ -n "$FAKE_TWO_MESSAGES" ]; then',
    '    printf \'%s\\n\' "{\\"reason\\":\\"compiler-artifact\\",\\"filenames\\":[\\"$out/stale/librustra_bridge.dylib\\"],\\"target\\":{\\"kind\\":[\\"cdylib\\"]}}"',
    '  fi',
    "  printf 'garbage line is skipped\\n'",
    '  printf \'%s\\n\' "{\\"reason\\":\\"compiler-artifact\\",\\"filenames\\":[\\"$out/librustra_bridge.dylib\\",\\"$out/librustra_bridge.so\\",\\"$out/rustra_bridge.dll\\"],\\"target\\":{\\"kind\\":[\\"cdylib\\"]}}"',
    '  printf \'fake dylib core\' > "$out/librustra_bridge.dylib"',
    '  printf \'fake dylib core\' > "$out/librustra_bridge.so"',
    '  printf \'fake dylib core\' > "$out/rustra_bridge.dll"',
    '  exit 0',
    'fi',
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
}

function seedCargoProject(root: string): string {
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  return project;
}

function dylibInput(project: string, rustPackage?: string): ResolvedDevDylib {
  return {
    manifestPath: join(project, 'Cargo.toml'),
    ...(rustPackage === undefined ? {} : { rustPackage }),
  };
}

test('buildDylibCore returns the cdylib artifact cargo reported and pins the JSON build flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-'));
  const originalPath = process.env.PATH;
  try {
    const project = seedCargoProject(root);
    seedFakeCargo(root);
    const log = join(root, 'build.log');
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_BUILD_LOG = log;
    try {
      const artifact = await buildDylibCore(dylibInput(project));
      const expected = hostArtifactName('rustra_bridge');
      if (expected !== undefined) {
        assert.equal(artifact, join(project, 'target', 'debug', expected));
      } else {
        // 호스트 확장자 표가 없는 플랫폼 — 수신 순 마지막 후보가 이긴다.
        assert.ok(artifact.endsWith('.dll'), `fallback must pick the last candidate: ${artifact}`);
      }
      const builds = readFileSync(log, 'utf8');
      assert.ok(
        builds.split('\n').some((line) => line.includes('--manifest-path')),
        `cargo build must pass the manifest explicitly, got:\n${builds}`,
      );
      assert.ok(
        builds.split('\n').some((line) => line.includes('--lib')),
        `the hot core is the lib target, got:\n${builds}`,
      );
      assert.ok(
        builds.split('\n').some((line) => line.includes('--message-format=json')),
        `artifact discovery reads compiler-artifact JSON from stdout, got:\n${builds}`,
      );
      assert.ok(
        !builds.split('\n').some((line) => line.includes('--package')),
        'no -p when rustPackage is unset — the single-package manifest needs no pin',
      );
    } finally {
      delete process.env.FAKE_BUILD_LOG;
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildDylibCore passes -p when rustPackage is resolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-p-'));
  const originalPath = process.env.PATH;
  try {
    const project = seedCargoProject(root);
    seedFakeCargo(root);
    const log = join(root, 'build.log');
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_BUILD_LOG = log;
    try {
      await buildDylibCore(dylibInput(project, 'x'));
      const builds = readFileSync(log, 'utf8');
      assert.ok(
        builds.split('\n').some((line) => line.includes('--package x')),
        `rustPackage must pin the built package, got:\n${builds}`,
      );
    } finally {
      delete process.env.FAKE_BUILD_LOG;
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pickCdylibArtifact prefers the freshest message over stale artifacts', () => {
  // 메시지 순서 = 빌드 순서 — 뒤 메시지가 최신 산출이다. stale/ 경로가 먼저 와도
  // 최신 메시지의 후보가 이겨야 한다(hot-core dlopen 대상은 최신 빌드 하나뿐).
  const stdout = [
    JSON.stringify({
      reason: 'compiler-artifact',
      filenames: ['/t/debug/stale/libhot.dylib'],
      target: { kind: ['cdylib'] },
    }),
    JSON.stringify({
      reason: 'compiler-artifact',
      filenames: ['/t/debug/libhot.dylib'],
      target: { kind: ['cdylib'] },
    }),
  ].join('\n');
  assert.equal(pickCdylibArtifact(stdout), '/t/debug/libhot.dylib');
  // cdylib 가 아닌 산출물(rmeta, bin)은 후보가 아니다.
  const withoutCdylib = [
    JSON.stringify({
      reason: 'compiler-artifact',
      filenames: ['/t/debug/libhot.rmeta'],
      target: { kind: ['lib'] },
    }),
    JSON.stringify({
      reason: 'compiler-artifact',
      filenames: ['/t/debug/hot.exe'],
      target: { kind: ['bin'] },
    }),
  ].join('\n');
  assert.equal(pickCdylibArtifact(withoutCdylib), undefined);
  assert.equal(pickCdylibArtifact('not json at all\n\n'), undefined);
});

test('buildDylibCore fails loudly when no cdylib artifact message appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-nocdylib-'));
  const originalPath = process.env.PATH;
  try {
    const project = seedCargoProject(root);
    seedFakeCargo(root);
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_NO_CDYLIB_MSG = '1';
    try {
      await assert.rejects(
        () => buildDylibCore(dylibInput(project)),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /no cdylib artifact/);
          assert.match(
            message,
            /crate-type/,
            'the error must include the crate-type "cdylib" fix hint',
          );
          assert.match(message, /package x/, 'the error must name the package');
          return true;
        },
      );
    } finally {
      delete process.env.FAKE_NO_CDYLIB_MSG;
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildDylibCore wraps cargo build failures with the package and manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-fail-'));
  const originalPath = process.env.PATH;
  try {
    const project = seedCargoProject(root);
    seedFakeCargo(root);
    process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
    process.env.FAKE_BUILD_FAIL = '1';
    try {
      await assert.rejects(
        () => buildDylibCore(dylibInput(project)),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /Rust dylib build failed for x/);
          assert.match(message, /exit 4/, 'the cargo exit status must survive the wrap');
          return true;
        },
      );
    } finally {
      delete process.env.FAKE_BUILD_FAIL;
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 게이트 통과 발행 — 라이브 아티팩트(atomic gated publish) ─────────────────
//
// cargo 타깃 경로는 빌드 스크래치고, 감시자(hot_core_watch)가 폴링하는 라이브 경로는
// 게이트 통과 빌드만 닿는다. 두 계약을 pin 한다:
//   (i)   liveArtifactPath — 같은 디렉터리에서 stem + `-hot-live` + 산출물 확장자
//         (.dylib/.so/.dll). 확장자 후보 밖이면 loud 실패.
//   (ii)  publishGatedArtifact — tmp 복사 → rename 스왑. 성공 시 바이트 동일·tmp 0개,
//         기존 라이브는 그 자리에서 덮어쓰고, 실패 시 tmp 를 치운 뒤 원인+결과를
//         함께 말한다(조용한 스킵 없음).

test('liveArtifactPath appends -hot-live in the artifact directory for each dylib extension', () => {
  assert.equal(
    liveArtifactPath('/t/debug/libhot.dylib'),
    join('/t/debug', 'libhot-hot-live.dylib'),
  );
  assert.equal(liveArtifactPath('/t/debug/libhot.so'), join('/t/debug', 'libhot-hot-live.so'));
  assert.equal(liveArtifactPath('/t/debug/hot.dll'), join('/t/debug', 'hot-hot-live.dll'));
  // dylib 확장자 밖 산출물(rmeta 등)은 라이브 경로의 근원이 될 수 없다 — loud 실패.
  assert.throws(() => liveArtifactPath('/t/debug/libhot.rmeta'), /cannot derive/);
});

test('publishGatedArtifact publishes identical bytes and leaves no tmp behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-publish-'));
  try {
    const source = join(dir, 'libhot.dylib');
    writeFileSync(source, 'gated core bytes');
    const live = liveArtifactPath(source);
    const published = publishGatedArtifact(source, live);
    assert.equal(published, live);
    assert.equal(readFileSync(live, 'utf8'), 'gated core bytes');
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.includes('-tmp-')),
      [],
      'a successful publish must not leave tmp files in the artifact directory',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishGatedArtifact overwrites a pre-existing live file', () => {
  // 재발행 계약 — 이전 발행물 위에 rename 으로 덮어쓴다(교체도 원자적).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-overwrite-'));
  try {
    const source = join(dir, 'libhot.dylib');
    const live = join(dir, 'libhot-hot-live.dylib');
    writeFileSync(source, 'new gated bytes');
    writeFileSync(live, 'old published bytes');
    publishGatedArtifact(source, live);
    assert.equal(readFileSync(live, 'utf8'), 'new gated bytes');
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.includes('-tmp-')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishGatedArtifact fails loudly, cleans the tmp, and leaves the live file untouched', () => {
  // 원인(소스 부재)과 결과(라이브 미갱신 — 호스트는 기존 코어 유지)를 함께 말하고,
  // tmp 잔여물을 조용히 두지 않는다.
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-publish-fail-'));
  try {
    const live = join(dir, 'libhot-hot-live.dylib');
    writeFileSync(live, 'previous published core');
    assert.throws(
      () => publishGatedArtifact(join(dir, 'missing.dylib'), live),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /failed to publish the gated live artifact/);
        assert.match(message, /libhot-hot-live\.dylib/, 'the error must name the live path');
        assert.match(
          message,
          /previously published core/,
          'the error must state the consequence (the host keeps the old core)',
        );
        return true;
      },
    );
    assert.equal(readFileSync(live, 'utf8'), 'previous published core');
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.includes('-tmp-')),
      [],
      'a failed publish must clean its tmp file — no silent leftovers',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── devDylib 설정 해석 — wasm 과 같은 우선순위 체인 ──────────────────────────

test('readDevConfig fills the dylib parityGate default when the section is omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-config-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        tauri: {},
        dev: { target: 'dylib' },
      }),
    );
    const config = readDevConfig(configPath);
    assert.equal(config.dev?.target, 'dylib');
    assert.deepEqual(
      config.dev?.dylib,
      { parityGate: true },
      'section-less dylib target still arms the gate by default',
    );
    assert.equal(
      config.devDylib?.manifestPath,
      config.manifestPath,
      'no explicit manifest → the codegen manifest is the hot-core manifest',
    );
    assert.equal(config.devDylib?.rustPackage, undefined);
    assert.equal(config.devWasm, undefined, 'dylib target must not resolve wasm inputs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig honors an explicit dylib parityGate false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-gateoff-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        dev: { target: 'dylib', dylib: { parityGate: false } },
      }),
    );
    const config = readDevConfig(configPath);
    assert.equal(config.dev?.dylib?.parityGate, false);
    assert.equal(config.devDylib?.manifestPath, config.manifestPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig resolves devDylib from reactNative first, then codegen, then the codegen manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-resolve-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    mkdirSync(join(dir, 'engine', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'engine', 'Cargo.toml'),
      '[package]\nname = "engine"\nversion = "0.1.0"\n',
    );

    // (1) 양쪽 rustManifest/rustPackage가 있으면 reactNative 가 이긴다 — wasm 의
    // devWasm 체인과 같은 우선순위다(tauri 레이아웃은 이 경로를 안 쓰지만 체인은
    // 하나여야 한다).
    const bothPath = join(dir, 'both.json');
    writeFileSync(
      bothPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        codegen: { rustManifest: './Cargo.toml', rustPackage: 'x' },
        reactNative: {
          moduleDir: 'modules',
          rustManifest: './engine/Cargo.toml',
          rustPackage: 'engine',
        },
        dev: { target: 'dylib' },
      }),
    );
    const both = readDevConfig(bothPath);
    assert.equal(both.devDylib?.manifestPath, join(dir, 'engine', 'Cargo.toml'));
    assert.equal(both.devDylib?.rustPackage, 'engine', 'reactNative.rustPackage wins too');

    // (2) codegen 만 설정 시 codegen 이 사용된다 — tauri 전용 레이아웃의 주 경로.
    const codegenOnlyPath = join(dir, 'codegen-only.json');
    writeFileSync(
      codegenOnlyPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        codegen: { rustManifest: './Cargo.toml', rustPackage: 'x' },
        dev: { target: 'dylib' },
      }),
    );
    const codegenOnly = readDevConfig(codegenOnlyPath);
    assert.equal(codegenOnly.devDylib?.manifestPath, join(dir, 'Cargo.toml'));
    assert.equal(codegenOnly.devDylib?.rustPackage, 'x');

    // (3) 어디에도 없으면 코드젠 매니페스트(상위 탐색 결과)로 폴백한다.
    const nonePath = join(dir, 'none.json');
    writeFileSync(
      nonePath,
      JSON.stringify({ schema: 'schema.json', output: 'generated', dev: { target: 'dylib' } }),
    );
    const none = readDevConfig(nonePath);
    assert.equal(none.devDylib?.manifestPath, none.manifestPath);
    assert.equal(none.devDylib?.rustPackage, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig leaves devDylib and the dylib section undefined for other targets', () => {
  // 절대 음성 — dylib 오케스트레이션 입력은 target=dylib 에서만 생긴다. wasm 섹션
  // 정규화(dylib 타깃에서 undefined)도 함께 핀다 — 두 대상의 resolved 섹션이 서로
  // 새지 않는다.
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-native-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        reactNative: { moduleDir: 'modules' },
        dev: { target: 'wasm', wasm: { engine: 'wasm3' } },
      }),
    );
    const config = readDevConfig(configPath);
    assert.equal(config.devDylib, undefined, 'wasm target must not resolve dylib inputs');
    assert.equal(config.dev?.dylib, undefined, 'wasm target must not normalize a dylib section');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig rejects a dylib section outside the dylib target', () => {
  // L2 — dylib 섹션의 위치 실패는 wasm 섹션과 대칭이다(로드 시점에 전부 수집).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-misplaced-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        dev: { dylib: { parityGate: true } },
      }),
    );
    assert.throws(() => readDevConfig(configPath), /dev\.dylib is only valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
