import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { portablePackagePath, resolveHostEntries } from './host-entries.js';
import type { RustraConfig } from './config.js';

// ── resolveHostEntries — 호스트 섹션 매니페스트 해석의 codegen 폴백 ──────────
//
// node/bun 섹션은 자체 rustManifest 가 없으면 **codegen.rustManifest 로 폴백**한
// 뒤에야 상위 탐색(findCargoManifest)으로 넘어간다 — wasm/dylib dev 타깃
// (dev-config)과 같은 우선순위다. 앱 루트에 자체 Cargo.toml 이 없는 레이아웃
// (tauri-calculator: Rust 코어가 ../calculator)에서 상위 탐색이 워크스페이스
// 가상 매니페스트에 닿아 "found 0 Cargo packages" 로 죽는 회귀(rustra.hot.json
// codegen 단계, 2026-09-09 웜루프 벤치에서 발견)를 고정한다.

/** 최소 크레이트 — lib(rlib+cdylib) + generate bin. cargo metadata 가 실제로 돈다. */
function seedLibCrate(root: string, name: string): void {
  const crate = join(root, 'lib');
  mkdirSync(join(crate, 'src', 'bin'), { recursive: true });
  writeFileSync(
    join(crate, 'Cargo.toml'),
    [
      '[package]',
      `name = "${name}"`,
      'version = "0.1.0"',
      'edition = "2021"',
      'publish = false',
      '',
      '[lib]',
      'crate-type = ["rlib", "cdylib"]',
      '',
      '[[bin]]',
      'name = "generate"',
      'path = "src/bin/generate.rs"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(crate, 'src', 'lib.rs'), 'pub fn placeholder() {}\n');
  writeFileSync(join(crate, 'src', 'bin', 'generate.rs'), 'fn main() {}\n');
}

test('host entries use the codegen invocation directory Cargo config and isolate its cache', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-host-cargo-cwd-')));
  const previous = process.env.CARGO_TARGET_DIR;
  try {
    delete process.env.CARGO_TARGET_DIR;
    seedLibCrate(root, 'context_probe');
    for (const name of ['first', 'second']) {
      const app = join(root, name);
      mkdirSync(join(app, '.cargo'), { recursive: true });
      writeFileSync(join(app, '.cargo', 'config.toml'), `[build]\ntarget-dir="${name}-target"\n`);
      const config: RustraConfig = {
        schema: './generated/schema.json',
        output: './generated',
        codegen: { rustManifest: '../lib/Cargo.toml' },
        node: {},
        bun: {},
      };
      const entries = resolveHostEntries(config, join(app, 'rustra.json'), join(app, 'generated'));
      assert.equal(entries?.node?.targetDirectoryUrl, `../${name}-target/`);
      assert.equal(entries?.bun?.targetDirectoryUrl, `../${name}-target/`);
    }
  } finally {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function writeConfig(appRoot: string, config: RustraConfig): string {
  const configPath = join(appRoot, 'rustra.json');
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

test('runtime target URLs survive symlinked app and Cargo target roots before outputs exist', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-host-runtime-symlinks-')));
  const previous = process.env.CARGO_TARGET_DIR;
  try {
    seedLibCrate(root, 'symlink_probe');
    const realApp = join(root, 'nested', 'real-app');
    const realCache = join(root, 'cache', 'nested');
    mkdirSync(realApp, { recursive: true });
    mkdirSync(realCache, { recursive: true });
    const app = join(root, 'app-link');
    const cache = join(root, 'cache-link');
    symlinkSync(realApp, app, 'dir');
    symlinkSync(realCache, cache, 'dir');
    const target = join(cache, 'not-built', 'target');
    process.env.CARGO_TARGET_DIR = target;
    const config: RustraConfig = {
      schema: 'schema.json',
      output: 'src/generated',
      codegen: { rustManifest: join(root, 'lib', 'Cargo.toml') },
      node: {},
      bun: {},
    };
    const output = join(app, 'src', 'generated');
    const entries = resolveHostEntries(config, writeConfig(app, config), output);
    for (const host of ['node', 'bun'] as const) {
      const entry = entries?.[host];
      assert.ok(entry);
      const importedEntry = pathToFileURL(join(realApp, 'src', 'generated', `${host}.ts`));
      assert.equal(
        fileURLToPath(new URL(entry.targetDirectoryUrl, importedEntry)),
        `${join(realCache, 'not-built', 'target')}/`,
      );
    }
    // RN/workspace package paths retain their caller's logical symlink layout.
    assert.equal(portablePackagePath(output, target), relative(output, target));
  } finally {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime target URLs preserve Cargo directory names containing URL delimiters', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rustra-host-runtime-url-')));
  const previous = process.env.CARGO_TARGET_DIR;
  try {
    seedLibCrate(root, 'url_probe');
    const app = join(root, 'app');
    mkdirSync(app);
    const config: RustraConfig = {
      schema: 'schema.json',
      output: 'generated',
      codegen: { rustManifest: '../lib/Cargo.toml' },
      node: {},
      bun: {},
    };
    const configPath = writeConfig(app, config);
    const output = join(app, 'generated');
    const mismatches: string[] = [];
    for (const directory of ['cargo#cache', 'cargo%20cache', 'cargo?cache', 'cargo cache']) {
      const target = join(root, directory, 'target');
      process.env.CARGO_TARGET_DIR = target;
      const entries = resolveHostEntries(config, configPath, output);
      for (const host of ['node', 'bun'] as const) {
        const entry = entries?.[host];
        assert.ok(entry);
        const importedEntry = pathToFileURL(join(output, `${host}.ts`));
        const actual = fileURLToPath(new URL(entry.targetDirectoryUrl, importedEntry));
        if (actual !== `${target}/`) mismatches.push(`${host} ${directory}: ${actual}`);
      }
      assert.equal(portablePackagePath(output, target), relative(output, target));
    }
    assert.deepEqual(mismatches, [], 'runtime URLs must preserve literal Cargo directory names');
  } finally {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('node/bun sections fall back to codegen.rustManifest before walking up', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-host-entries-'));
  try {
    // 앱 루트에는 Cargo.toml 이 없다 — Rust 코어는 형제 디렉터리(lib/)에 있다.
    const appRoot = join(root, 'app');
    mkdirSync(appRoot, { recursive: true });
    seedLibCrate(root, 'hot_fallback_lib');
    const outputPath = join(appRoot, 'generated');
    mkdirSync(outputPath, { recursive: true });
    const configPath = writeConfig(appRoot, {
      schema: 'schema.json',
      output: 'generated',
      codegen: { rustManifest: '../lib/Cargo.toml' },
      node: {},
      bun: {},
    } as RustraConfig);

    const entries = resolveHostEntries(
      {
        schema: 'schema.json',
        output: 'generated',
        codegen: { rustManifest: '../lib/Cargo.toml' },
        node: {},
        bun: {},
      },
      configPath,
      outputPath,
    );
    assert.ok(entries?.node, 'node entry must resolve via the codegen manifest fallback');
    assert.equal(entries.node.targetName, 'generate');
    assert.match(entries.node.targetDirectoryUrl, /\/target\//);
    assert.ok(entries.bun, 'bun entry must resolve the same way');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node section still fails loud when neither section nor codegen names a manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-host-entries-missing-'));
  try {
    // findCargoManifest 가 실제로 실패하는 위치를 만들기 위해 파일시스템 최상단
    // 근처까지 올라가지 않는 임시 루트만 사용한다 — 루트 자체에 Cargo.toml 이
    // 없고 codegen 힌트도 없으면 상위 탐색은 tmp 상위에서 워크스페이스 매니페스트
    // 을 만날 수 없다(저장소 바깥 tmpdir).
    const appRoot = join(root, 'app');
    mkdirSync(appRoot, { recursive: true });
    const configPath = writeConfig(appRoot, {
      schema: 'schema.json',
      output: 'generated',
      node: {},
    } as RustraConfig);
    assert.throws(
      () =>
        resolveHostEntries(
          { schema: 'schema.json', output: 'generated', node: {} },
          configPath,
          join(appRoot, 'generated'),
        ),
      /Node setup could not find Cargo\.toml/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
