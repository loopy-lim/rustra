import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHostEntries } from './host-entries.js';
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

function writeConfig(appRoot: string, config: RustraConfig): string {
  const configPath = join(appRoot, 'rustra.json');
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

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
      () => resolveHostEntries({ schema: 'schema.json', output: 'generated', node: {} }, configPath, join(appRoot, 'generated')),
      /Node setup could not find Cargo\.toml/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
