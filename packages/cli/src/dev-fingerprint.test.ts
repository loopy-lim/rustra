import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCargoMetadata } from './cargo-metadata.js';
import { createFileWatch, createSourceWatch } from './watch.js';
import {
  devInputFingerprint,
  resolveRustInputPaths,
  rustInputFingerprint,
} from './dev-fingerprint.js';

// ── rustInputFingerprint — 코드젠 대상 Rust 입력 지문 (warm-loop Stage 1) ────
//
// 지문 계약: 같은 트리는 같은 지문(결정적), 내용이 바뀌면 반드시 다른 지문,
// mtime 만의 변화는 지문을 움직이지 않는다(build 도구의 재쓰기 오탐 방지),
// 감시자와 같은 제외 규칙(target/node_modules/.git), 불확실한 fs 상태는
// 삼키지 않고 throw(호출자가 전체 파이프라인 fail-safe 로 번역).

/** 오염 시나리오의 원본 — derive·attribute·필드를 모두 가진 모양. */
const LIB_RS_V1 = [
  '#[derive(Debug, Clone)]',
  '#[serde(rename_all = "camelCase")]',
  'pub struct EchoInput {',
  '    pub message: String,',
  '}',
  '',
].join('\n');

function seedCrate(dir: string): string {
  const project = join(dir, 'proj');
  mkdirSync(join(project, 'src', 'bin'), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(join(project, 'Cargo.lock'), 'version = 3\n');
  writeFileSync(join(project, 'src', 'lib.rs'), LIB_RS_V1);
  writeFileSync(join(project, 'src', 'bin', 'generate.rs'), 'fn main() {}\n');
  return project;
}

/** dev.ts 와 같은 루트 구성 — src 트리 + Cargo.toml + Cargo.lock. */
function fingerprintOf(project: string): string {
  return rustInputFingerprint([
    join(project, 'src'),
    join(project, 'Cargo.toml'),
    join(project, 'Cargo.lock'),
  ]);
}

for (const source of ['config', 'environment'] as const) {
  test(`dev inputs resolve relative Cargo dep-info from ${source} basedir`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-relative-dep-info-')));
    const previous = process.env.CARGO_BUILD_DEP_INFO_BASEDIR;
    const oldTarget = process.env.CARGO_TARGET_DIR;
    try {
      const project = join(root, 'app');
      const base = root;
      mkdirSync(join(project, 'src'), { recursive: true });
      writeFileSync(
        join(project, 'Cargo.toml'),
        '[package]\nname="relative_probe"\nversion="0.1.0"\n',
      );
      writeFileSync(join(root, 'payload.txt'), 'first');
      writeFileSync(
        join(project, 'src', 'lib.rs'),
        'pub static DATA: &str = include_str!("../../payload.txt");',
      );
      delete process.env.CARGO_BUILD_DEP_INFO_BASEDIR;
      if (source === 'environment') process.env.CARGO_BUILD_DEP_INFO_BASEDIR = base;
      else {
        mkdirSync(join(project, '.cargo'));
        writeFileSync(join(project, '.cargo', 'config.toml'), '[build]\ndep-info-basedir=".."\n');
      }
      process.env.CARGO_TARGET_DIR = join(root, 'target');
      execFileSync('cargo', ['build', '--quiet', '--manifest-path', join(project, 'Cargo.toml')], {
        cwd: project,
      });
      const paths = resolveRustInputPaths(join(project, 'Cargo.toml'));
      assert.ok(
        paths.files.includes(join(root, 'payload.txt')),
        'relative external input is watched',
      );
      const before = devInputFingerprint(paths);
      writeFileSync(join(root, 'payload.txt'), 'second');
      assert.notEqual(devInputFingerprint(paths), before);
    } finally {
      if (previous === undefined) delete process.env.CARGO_BUILD_DEP_INFO_BASEDIR;
      else process.env.CARGO_BUILD_DEP_INFO_BASEDIR = previous;
      if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = oldTarget;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('dev inputs exclude custom Cargo output directories under a root-level library', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-custom-output-')));
  const oldCwd = process.cwd();
  const oldTarget = process.env.CARGO_TARGET_DIR;
  try {
    mkdirSync(join(root, '.cargo'));
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="root_lib"\nversion="0.1.0"\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(root, 'lib.rs'), 'pub fn value() {}');
    writeFileSync(join(root, '.cargo', 'config.toml'), '[build]\ntarget-dir="compiled-output"\n');
    process.chdir(root);
    delete process.env.CARGO_TARGET_DIR;
    const paths = resolveRustInputPaths(join(root, 'Cargo.toml'));
    const before = devInputFingerprint(paths);
    mkdirSync(join(root, 'compiled-output', 'debug'), { recursive: true });
    writeFileSync(join(root, 'compiled-output', 'debug', 'output.o'), 'compiler write');
    assert.equal(
      devInputFingerprint(paths),
      before,
      'Cargo outputs must not invalidate their own build, regardless of directory name',
    );
  } finally {
    process.chdir(oldCwd);
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const name of ['rust-toolchain', 'rust-toolchain.toml']) {
  test(`dev inputs observe creation of ${name} in the invocation ancestry`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-toolchain-')));
    const handles: Array<{ dispose(): void }> = [];
    try {
      const project = seedCrate(join(root, 'manifest'));
      const cwd = join(root, 'invocation', 'nested');
      mkdirSync(cwd, { recursive: true });
      const toolchain = join(root, 'invocation', name);
      const paths = resolveRustInputPaths(join(project, 'Cargo.toml'), undefined, cwd);
      assert.ok(paths.files.includes(toolchain), 'future toolchain selection files are watched');
      const before = devInputFingerprint(paths);
      const changes: string[] = [];
      handles.push(createFileWatch([{ path: toolchain, onChange: (path) => changes.push(path) }]));
      writeFileSync(
        toolchain,
        name.endsWith('.toml') ? '[toolchain]\nchannel="stable"\n' : 'stable\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.notEqual(devInputFingerprint(paths), before, 'toolchain selection changes inputs');
      assert.ok(changes.includes(toolchain), 'a running dev session observes toolchain creation');
    } finally {
      for (const handle of handles) handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('dev inputs preserve Rust sources when Cargo target-dir shares the project root', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-shared-output-')));
  const oldTarget = process.env.CARGO_TARGET_DIR;
  const handles: Array<{ dispose(): void }> = [];
  try {
    delete process.env.CARGO_TARGET_DIR;
    mkdirSync(join(root, '.cargo'));
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="shared_root"\nversion="0.1.0"\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(root, 'lib.rs'), 'pub fn value() {}');
    writeFileSync(join(root, '.cargo', 'config.toml'), '[build]\ntarget-dir="."\n');
    const manifest = join(root, 'Cargo.toml');
    assert.equal(
      realpathSync(readCargoMetadata(manifest, root).target_directory!),
      root,
      'real Cargo layout',
    );
    execFileSync('cargo', ['generate-lockfile', '--quiet', '--manifest-path', manifest], {
      cwd: root,
    });
    const paths = resolveRustInputPaths(manifest, undefined, root);
    const before = devInputFingerprint(paths);
    const changes: string[] = [];
    for (const tree of paths.trees)
      handles.push(createSourceWatch(tree, (path) => changes.push(path), paths.excluded));
    writeFileSync(join(root, 'lib.rs'), 'pub fn changed() {}');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.notEqual(devInputFingerprint(paths), before, 'target-dir must not hide Rust sources');
    assert.ok(changes.includes(join(root, 'lib.rs')), 'source edits still trigger the dev watcher');
    const afterSource = devInputFingerprint(paths);
    changes.length = 0;
    execFileSync('cargo', ['build', '--quiet', '--manifest-path', manifest], { cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      devInputFingerprint(paths),
      afterSource,
      `owned Cargo outputs are ignored: ${changes.join(', ')}`,
    );
    assert.ok(!changes.some((path) => path.endsWith('.rlib') || path.endsWith('.rmeta')));
    // A profile directory may also contain an ordinary Rust module.
    writeFileSync(join(root, 'debug', 'module.rs'), 'pub fn nested() {}');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.notEqual(
      devInputFingerprint(paths),
      afterSource,
      'sources alongside artifacts remain inputs',
    );
    assert.ok(changes.includes(join(root, 'debug', 'module.rs')));
  } finally {
    for (const handle of handles) handle.dispose();
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev inputs protect engine sources from another producer sharing their target directory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-producer-overlap-')));
  const oldTarget = process.env.CARGO_TARGET_DIR;
  const handles: Array<{ dispose(): void }> = [];
  try {
    const payload = join(root, 'payload.txt');
    writeFileSync(payload, 'engine input');
    for (const producer of ['schema', 'engine']) {
      const directory = join(root, producer);
      mkdirSync(join(directory, 'src'), { recursive: true });
      writeFileSync(
        join(directory, 'Cargo.toml'),
        `[package]\nname="${producer}"\nversion="0.1.0"\n` +
          (producer === 'engine' ? '[profile.fast]\ninherits="dev"\n' : ''),
      );
      writeFileSync(
        join(directory, 'src', 'lib.rs'),
        'pub fn value() {}' +
          (producer === 'engine'
            ? '\npub static DATA: &str = include_str!("../../payload.txt");'
            : ''),
      );
      execFileSync('cargo', ['generate-lockfile', '--quiet'], { cwd: directory });
    }
    const schema = join(root, 'schema');
    const engine = join(root, 'engine');
    process.env.CARGO_TARGET_DIR = join(engine, 'src');
    execFileSync('cargo', ['build', '--quiet', '--profile', 'fast'], { cwd: engine });
    const paths = resolveRustInputPaths(join(schema, 'Cargo.toml'), undefined, schema, [
      { manifestPath: join(engine, 'Cargo.toml'), cwd: engine },
    ]);
    assert.ok(
      paths.files.includes(payload),
      'additional producer custom-profile dep-info is discovered',
    );
    const before = devInputFingerprint(paths);
    const changes: string[] = [];
    for (const tree of paths.trees)
      handles.push(createSourceWatch(tree, (path) => changes.push(path), paths.excluded));
    const source = join(engine, 'src', 'lib.rs');
    writeFileSync(source, 'pub fn changed() {}');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.notEqual(
      devInputFingerprint(paths),
      before,
      'another producer cannot hide engine source',
    );
    assert.ok(changes.includes(source), 'the combined watcher observes engine source');
    const afterSource = devInputFingerprint(paths);
    execFileSync('cargo', ['build', '--quiet'], { cwd: engine });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      devInputFingerprint(paths),
      afterSource,
      'shared engine Cargo outputs remain excluded',
    );
  } finally {
    for (const handle of handles) handle.dispose();
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev input resolution preserves two invocation cwd contexts for the same manifest', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-producer-cwd-')));
  const oldTarget = process.env.CARGO_TARGET_DIR;
  try {
    delete process.env.CARGO_TARGET_DIR;
    const app = join(root, 'app');
    const invoker = join(root, 'invoker');
    for (const directory of [app, invoker])
      mkdirSync(join(directory, '.cargo'), { recursive: true });
    writeFileSync(
      join(app, 'Cargo.toml'),
      '[package]\nname="same_manifest"\nversion="0.1.0"\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(app, 'lib.rs'), 'pub fn value() {}');
    writeFileSync(join(app, '.cargo', 'config.toml'), '[build]\ntarget-dir="second-output"\n');
    writeFileSync(
      join(invoker, '.cargo', 'config.toml'),
      '[build]\ntarget-dir="../app/first-output"\n',
    );
    const manifest = join(app, 'Cargo.toml');
    const paths = resolveRustInputPaths(manifest, undefined, invoker, [
      { manifestPath: manifest, cwd: app },
    ]);
    const before = devInputFingerprint(paths);
    mkdirSync(join(app, 'second-output', 'debug'), { recursive: true });
    writeFileSync(join(app, 'second-output', 'debug', 'libsame_manifest.rlib'), 'engine output');
    assert.equal(
      devInputFingerprint(paths),
      before,
      'each actual Cargo cwd contributes its output boundary',
    );
  } finally {
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev inputs follow compiler and build-script inputs outside the source tree', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-dep-info-')));
  try {
    const project = join(root, 'app');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(
      join(project, 'Cargo.toml'),
      '[package]\nname="depinfo_probe"\nversion="0.1.0"\n',
    );
    writeFileSync(join(root, 'payload.txt'), 'first');
    writeFileSync(join(root, 'build-input.txt'), 'first');
    writeFileSync(
      join(project, 'src', 'lib.rs'),
      'pub static CONTENT: &str = include_str!("../../payload.txt");\n',
    );
    writeFileSync(
      join(project, 'build.rs'),
      'fn main() { println!("cargo:rerun-if-changed=../build-input.txt"); }\n',
    );
    execFileSync('cargo', ['build', '--quiet', '--manifest-path', join(project, 'Cargo.toml')], {
      cwd: project,
      env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') },
    });
    const oldTarget = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = join(root, 'target');
    let paths;
    try {
      paths = resolveRustInputPaths(join(project, 'Cargo.toml'));
    } finally {
      if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = oldTarget;
    }
    assert.ok(paths.files.includes(join(root, 'payload.txt')), 'include_str input is watched');
    assert.ok(
      paths.files.includes(join(root, 'build-input.txt')),
      'rerun-if-changed input is watched',
    );
    const before = devInputFingerprint(paths);
    writeFileSync(join(root, 'payload.txt'), 'second');
    assert.notEqual(devInputFingerprint(paths), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev fingerprint excludes owned generated trees and files without hiding source edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-owned-output-'));
  try {
    const project = seedCrate(root);
    const generated = join(project, 'src', 'generated');
    const mirror = join(project, 'src', 'uniffi_generated.rs');
    mkdirSync(generated);
    writeFileSync(join(generated, 'commands.ts'), 'generated v1');
    writeFileSync(mirror, 'mirror v1');
    const paths = { trees: [join(project, 'src')], files: [], excluded: [generated, mirror] };
    const before = devInputFingerprint(paths);
    writeFileSync(join(generated, 'commands.ts'), 'generated v2');
    writeFileSync(mirror, 'mirror v2');
    assert.equal(
      devInputFingerprint(paths),
      before,
      'codegen writes must not cause another expensive Rust build',
    );
    writeFileSync(join(project, 'src', 'lib.rs'), 'pub fn changed() {}');
    assert.notEqual(devInputFingerprint(paths), before, 'real source edits still invalidate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev fingerprint follows a symlinked source root like its watcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-root-link-'));
  try {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'lib.rs'), 'pub fn one() {}');
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    const paths = { trees: [join(root, 'linked')], files: [] };
    const before = devInputFingerprint(paths);
    writeFileSync(join(root, 'real', 'lib.rs'), 'pub fn two() {}');
    assert.notEqual(
      devInputFingerprint(paths),
      before,
      'a watched source edit must not be skipped because the root is a symlink',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev inputs include transitive local dependencies, custom targets and workspace files', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-dev-dependencies-')));
  try {
    for (const name of ['app', 'shared', 'leaf']) mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[workspace]\nmembers=["app", "shared", "leaf"]\nresolver="2"\n',
    );
    for (const [name, dependency] of [
      ['app', 'shared'],
      ['shared', 'leaf'],
      ['leaf', ''],
    ] as const) {
      writeFileSync(
        join(root, name, 'Cargo.toml'),
        `[package]\nname="${name}"\nversion="0.1.0"\n[lib]\npath="backend/lib.rs"\n` +
          (dependency ? `[dependencies]\n${dependency}={path="../${dependency}"}\n` : ''),
      );
      mkdirSync(join(root, name, 'backend'));
      writeFileSync(join(root, name, 'backend', 'lib.rs'), 'pub fn value() {}');
    }
    const paths = resolveRustInputPaths(join(root, 'app', 'Cargo.toml'));
    assert.ok(paths.trees.includes(join(root, 'leaf', 'backend')));
    assert.ok(paths.files.includes(join(root, 'Cargo.lock')));
    assert.ok(paths.files.includes(join(root, 'app', 'build.rs')));
    assert.ok(paths.files.includes(join(root, '.cargo', 'config.toml')));
    const first = devInputFingerprint(paths);
    writeFileSync(join(root, 'leaf', 'backend', 'lib.rs'), 'pub fn changed() {}');
    assert.notEqual(devInputFingerprint(paths), first);
    const second = devInputFingerprint(paths);
    writeFileSync(join(root, 'app', 'build.rs'), 'fn main() {}');
    assert.notEqual(
      devInputFingerprint(paths),
      second,
      'creating a build script changes the inputs',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rustInputFingerprint is deterministic and ignores mtime-only changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-det-'));
  try {
    const project = seedCrate(dir);
    const first = fingerprintOf(project);
    assert.equal(fingerprintOf(project), first, 'the same tree must hash identically');
    // 내용 불변 재시점화(빌드 도구의 touch) — mtime 이 움직여도 지문은 그대로다.
    utimesSync(join(project, 'src', 'lib.rs'), new Date(), new Date('2020-01-01T00:00:00Z'));
    utimesSync(join(project, 'Cargo.toml'), new Date(), new Date('2020-01-01T00:00:00Z'));
    assert.equal(fingerprintOf(project), first, 'mtime-only changes must not move the fingerprint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint walks nested source trees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-nested-'));
  try {
    const project = seedCrate(dir);
    const before = fingerprintOf(project);
    writeFileSync(join(project, 'src', 'bin', 'generate.rs'), 'fn main() { /* c */ }\n');
    assert.notEqual(
      fingerprintOf(project),
      before,
      'a nested module edit is part of the codegen inputs',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all five schema-contamination edits change the fingerprint', () => {
  // 계획 Stage 1 의 오염 시나리오 5종 — 스키마는 컴파일된 Rust 에서만 나오므로
  // 지문은 토큰 수준이 아니라 **내용** 수준에서 틀린다. 어떤 편집도 지문 불변으로
  // 지나가면 스킵이 스키마 드리프트를 삼키는 false-negative 다.
  const mutations: Array<[string, string]> = [
    [
      'a field addition',
      LIB_RS_V1.replace('pub message: String,', 'pub message: String,\n    pub count: i64,'),
    ],
    ['a field rename', LIB_RS_V1.replace('pub message:', 'pub text:')],
    ['a field type change', LIB_RS_V1.replace('message: String', 'message: i64')],
    ['an attribute removal', LIB_RS_V1.replace('#[serde(rename_all = "camelCase")]\n', '')],
    ['a derive change', LIB_RS_V1.replace('#[derive(Debug, Clone)]', '#[derive(Debug)]')],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-contam-'));
  try {
    const project = seedCrate(dir);
    const lib = join(project, 'src', 'lib.rs');
    for (const [what, mutated] of mutations) {
      const base = fingerprintOf(project);
      writeFileSync(lib, mutated);
      assert.notEqual(fingerprintOf(project), base, `${what} must change the fingerprint`);
      writeFileSync(lib, LIB_RS_V1);
      assert.equal(fingerprintOf(project), base, `undoing ${what} must restore the fingerprint`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint covers Cargo.toml and Cargo.lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-manifest-'));
  try {
    const project = seedCrate(dir);
    const base = fingerprintOf(project);
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.2.0"\n');
    assert.notEqual(fingerprintOf(project), base, 'a manifest edit is a codegen input');
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const afterManifest = fingerprintOf(project);
    writeFileSync(join(project, 'Cargo.lock'), 'version = 4\n');
    assert.notEqual(fingerprintOf(project), afterManifest, 'a lockfile edit is a codegen input');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint excludes target, node_modules, and .git at any depth', () => {
  // 감시자(watch.ts snapshotPath)와 같은 제외 규칙 — 빌드·캐시 트리의 쓰기는
  // 코드젠 입력이 아니므로 지문도 움직여서는 안 된다(그렇지 않으면 스킵이 없다).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-exclude-'));
  try {
    const project = seedCrate(dir);
    const base = fingerprintOf(project);
    for (const excluded of ['target', 'node_modules', '.git']) {
      mkdirSync(join(project, 'src', excluded), { recursive: true });
      writeFileSync(join(project, 'src', excluded, 'noise.rs'), 'pub struct Noise;');
    }
    assert.equal(fingerprintOf(project), base, 'build/cache trees must not enter the fingerprint');
    // 대조 — 같은 자리의 실제 소스 파일은 지문을 움직인다.
    writeFileSync(join(project, 'src', 'noise.rs'), 'pub struct Noise;');
    assert.notEqual(fingerprintOf(project), base, 'a real source addition must be seen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint hashes symlink entries without following them', () => {
  // 감시자의 no-follow 규약 — 링크된 트리 밖 내용은 지문에 들어가지 않고, 링크
  // 자체의 유무·대상 텍스트가 지문이다(트리 밖 추종·사이클 진입 방지).
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-symlink-'));
  try {
    const project = seedCrate(dir);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.rs'), 'pub struct Leak;');
    symlinkSync(outside, join(project, 'src', 'vendor'));
    const withLink = fingerprintOf(project);
    writeFileSync(join(outside, 'leak.rs'), 'pub struct Leak2;');
    assert.equal(
      fingerprintOf(project),
      withLink,
      'content behind a symlink must not enter the fingerprint',
    );
    rmSync(join(project, 'src', 'vendor'));
    assert.notEqual(fingerprintOf(project), withLink, 'removing the link must be seen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rustInputFingerprint throws on uncertain filesystem state instead of guessing', () => {
  // fail-safe 계약 — 없는 루트(ENOENT)·파일 아래의 경로(ENOTDIR) 같은 불확실성은
  // "빈 기여"로 삼키지 않고 전파한다. dev 루프는 throw 를 스킵 금지로 번역한다.
  const dir = mkdtempSync(join(tmpdir(), 'rustra-fp-error-'));
  try {
    const project = seedCrate(dir);
    assert.throws(
      () => rustInputFingerprint([join(dir, 'missing-crate')]),
      /ENOENT/,
      'a missing root is uncertainty, not an empty input',
    );
    rmSync(join(project, 'Cargo.lock'));
    assert.throws(
      () => fingerprintOf(project),
      /ENOENT/,
      'a vanished input file is uncertainty too',
    );
    assert.throws(
      () => rustInputFingerprint([join(project, 'Cargo.toml', 'nested')]),
      /ENOTDIR/,
      'a path below a regular file cannot be walked',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
