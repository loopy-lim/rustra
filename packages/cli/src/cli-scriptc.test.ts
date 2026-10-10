// scriptc 오케스트레이터 계약 — cargo metadata 를 쓰지 않는 경로(archive 오버라이드)
// 로 쓰기→검증 라운드트립을 검증한다. 렌더 내용 자체의 골드는
// cli-generate-scriptc.test.ts 가 담당하고, 여기서는 경로 해상도·쓰기·check 모드
// drift 판정(wrapError 대신 구체적 drift 메시지)만 고정한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RustraScriptcConfig } from './config.js';
import { SCRIPTC_DECLARATIONS_FILE, SCRIPTC_MANIFEST_FILE } from './cli-generate-scriptc.js';
import {
  checkScriptcStage,
  resolveScriptcArchive,
  resolveScriptcOutDir,
  runScriptcStage,
  type ScriptcStageInput,
} from './cli-scriptc.js';

const CALCULATOR_SCHEMA_PATH = fileURLToPath(
  new URL('../../../examples/calculator/generated/schema.json', import.meta.url),
);

function makeInput(root: string, overrides: Partial<RustraScriptcConfig> = {}): ScriptcStageInput {
  const scriptc: RustraScriptcConfig = { output: 'out', archive: 'libs/libface.a', ...overrides };
  const configPath = join(root, 'rustra.json');
  const schemaOutDir = join(root, 'schema');
  mkdirSync(schemaOutDir, { recursive: true });
  mkdirSync(join(root, 'libs'), { recursive: true });
  writeFileSync(configPath, '{}');
  writeFileSync(join(schemaOutDir, 'schema.json'), readFileSync(CALCULATOR_SCHEMA_PATH, 'utf8'));
  // 존재 검사 대상 더미 아카이브 — 내용은 관계없다(정적 링크는 scriptc build 의 몫).
  writeFileSync(join(root, 'libs', 'libface.a'), 'fake archive bytes');
  return {
    configPath,
    scriptc,
    target: { manifestPath: join(root, 'Cargo.toml'), packageName: 'face', cwd: root },
    schemaOutDir,
    progress: () => {},
  };
}

test('resolveScriptcOutDir resolves relative to the config directory', () => {
  const scriptc: RustraScriptcConfig = { output: 'native/scriptc' };
  assert.equal(resolveScriptcOutDir('/app/config', scriptc), resolve('/app/config/native/scriptc'));
});

test('resolveScriptcArchive override yields a manifest-relative forward-slash libraryRef', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-scriptc-archive-'));
  try {
    const input = makeInput(root);
    const outDir = resolveScriptcOutDir(resolve(root), input.scriptc);
    const ref = resolveScriptcArchive(input, outDir);
    assert.equal(ref.archivePath, join(root, 'libs', 'libface.a'));
    assert.equal(ref.libraryRef, '../libs/libface.a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runScriptcStage writes both artifacts; checkScriptcStage accepts them', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-scriptc-roundtrip-'));
  try {
    const input = makeInput(root);
    const written = runScriptcStage(input);
    assert.deepEqual(written, [
      join(root, 'out', SCRIPTC_MANIFEST_FILE),
      join(root, 'out', SCRIPTC_DECLARATIONS_FILE),
    ]);
    assert.ok(existsSync(written[0]!) && existsSync(written[1]!));
    // 매니페스트의 libraries 는 out 디렉터리 기준 상대경로로 커밋된다.
    const manifest = JSON.parse(readFileSync(written[0]!, 'utf8')) as {
      libraries: string[];
    };
    assert.deepEqual(manifest.libraries, ['../libs/libface.a']);
    // 재현 결과가 커밋 파일과 일치 — drift 없음.
    checkScriptcStage(input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkScriptcStage fails closed on tampered and missing committed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-scriptc-drift-'));
  try {
    const input = makeInput(root);
    runScriptcStage(input);
    const manifestPath = join(root, 'out', SCRIPTC_MANIFEST_FILE);
    // tamper → disk-changed drift
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace('"ffi_format"', '"ffiFormat"'),
    );
    assert.throws(() => checkScriptcStage(input), /scriptc drift \(disk changed\).*rustra codegen/);
    // restore → pass, then remove → missing drift
    runScriptcStage(input);
    rmSync(manifestPath);
    assert.throws(() => checkScriptcStage(input), /scriptc drift \(missing\).*rustra codegen/);
    rmSync(join(root, 'out', SCRIPTC_DECLARATIONS_FILE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runScriptcStage refuses to write when the archive is absent (write mode only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-scriptc-noarchive-'));
  try {
    const input = makeInput(root);
    rmSync(join(root, 'libs', 'libface.a'));
    assert.throws(() => runScriptcStage(input), /archive not found.*cargo build/);
    // check 모드는 아카이브 없이도 렌더 바이트 비교가 가능하다 — 커밋 파일이
    // 없어 missing drift 로 실패하지, 아카이브 에러로 실패하지 않는다.
    assert.throws(() => checkScriptcStage(input), /scriptc drift \(missing\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
