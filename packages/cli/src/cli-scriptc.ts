/**
 * scriptc 코드젠 오케스트레이션 — scriptc Native FFI 단계(ffi.json +
 * scriptc-ffi.d.ts 쓰기/검증)를 cli-codegen.ts 에서 분리한 모듈이다. 렌더링은
 * cli-generate-scriptc.ts(문자열만, scriptc 바이너리 없이 검증 가능)가 담당하고
 * 이 모듈은 경로 해상도·쓰기·check 모드 바이트 비교만 한다. uniffi 단계
 * (cli-uniffi.ts)와 같은 계약: 스폰/파일 실패는 원인을 보존한 문맥 에러로 감싸고,
 * 기대 산출물 부재는 fail-closed 다.
 *
 * uniffi 와 다른 점 두 가지 —
 *   1. 이 단계는 cargo build 를 하지 않는다(staleBinaryHint 와 같은 원칙: codegen 은
 *      런타임 바이너리를 재빌드하지 않는다). 대신 write 모드에서 staticlib 아카이브
 *      존재를 fail-closed 로 검사해 "scriptc build 가 아카이브를 못 찾는" 후행
 *      실패를 선행 에러로 바꾼다. check 모드는 렌더 문자열 바이트 비교만 하므로
 *      아카이브가 없어도 된다(CI 가 정적 링크 바이너리 없이 신선도를 검증한다).
 *   2. target 디렉터리는 규약 재발명 대신 cargo metadata 에서 읽는다 — 예제
 *      계산기처럼 워크스페이스 루트 target/ 에 아카이브가 모이는 레이아웃에서
 *      manifest 인접 target/ 추측은 틀린다. scriptc 도 매니페스트의 libraries 를
 *      **매니페스트 파일 위치 기준 상대경로**로 해석하므로(scriptc.dev/docs/ffi),
 *      커밋 ffi.json 에는 out 디렉터리 기준 상대경로를 박는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { RustraScriptcConfig } from './config.js';
import {
  SCRIPTC_DECLARATIONS_FILE,
  SCRIPTC_MANIFEST_FILE,
  generateScriptcArtifacts,
  resolveScriptcArchivePath,
} from './cli-generate-scriptc.js';
import { readCargoMetadata, requireTargetDirectory, selectHostPackage } from './cargo-metadata.js';

/** 코드젠 타깃 — uniffi 단계와 같은 스폰 컨텍스트(resolveCodegenTarget 산출물). */
export type ScriptcTargetContext = {
  manifestPath: string;
  packageName: string;
  cwd: string;
};

export type ScriptcStageInput = {
  configPath: string;
  scriptc: RustraScriptcConfig;
  target: ScriptcTargetContext;
  /**
   * 신선한 스키마 디렉터리 — write 모드는 커밋 위치(config.schema 의 디렉터리),
   * check 모드는 임시 렌더 디렉터리(checkRoot). 스키마 파일은 둘 다 schema.json 이다.
   */
  schemaOutDir: string;
  progress: (message: string) => void;
};

/** scriptc 출력 디렉터리 — config 파일 위치 기준 상대경로(schema/output 과 같은 관례). */
export function resolveScriptcOutDir(configDir: string, scriptc: RustraScriptcConfig): string {
  return resolve(configDir, scriptc.output);
}

export type ScriptcArchiveRef = {
  /** 존재 검사용 절대 경로(write 모드 fail-closed 검사의 대상). */
  archivePath: string;
  /** 커밋 ffi.json 의 libraries 에 박는 참조 — out 디렉터리 기준 상대경로(forward slash). */
  libraryRef: string;
};

/**
 * staticlib 아카이브 해상도 — scriptc.archive 오버라이드가 없으면 cargo metadata
 * target 디렉터리에서 lib<package>(하이픈→밑줄).a 규약으로 찾고, 타깃 패키지가
 * staticlib 크레이트 타입을 선언하는지 함께 검증한다(uniffi 의 cdylib 검사와 같은
 * fail-closed). 오버라이드는 전용 ffi 크레이트가 아카이브를 소유하는 워크스페이스
 * 레이아웃을 위한 탈출구다.
 */
export function resolveScriptcArchive(
  input: Pick<ScriptcStageInput, 'configPath' | 'scriptc' | 'target'>,
  outDir: string,
): ScriptcArchiveRef {
  const { configPath, scriptc, target } = input;
  const configDir = resolve(configPath, '..');
  if (scriptc.archive !== undefined) {
    const archivePath = resolve(configDir, scriptc.archive);
    return { archivePath, libraryRef: toLibraryRef(archivePath, outDir) };
  }
  const metadata = readCargoMetadata(target.manifestPath, target.cwd);
  const pkg = selectHostPackage(metadata, target.manifestPath, target.packageName);
  if (!pkg.targets.some((candidate) => candidate.crate_types.includes('staticlib'))) {
    throw new Error(
      `scriptc requires a staticlib target in ${pkg.name}; declare ` +
        `crate-type = ["rlib", "staticlib"], or point scriptc.archive at the archive ` +
        `a dedicated ffi crate builds`,
    );
  }
  const profile = scriptc.profile ?? 'release';
  const archivePath = resolveScriptcArchivePath(
    requireTargetDirectory(metadata),
    pkg.name,
    profile,
  );
  return { archivePath, libraryRef: toLibraryRef(archivePath, outDir) };
}

/** 절대 아카이브 경로 → 매니페스트 참조(scriptc 는 매니페스트 위치 기준으로 해석). */
function toLibraryRef(archivePath: string, outDir: string): string {
  return relative(outDir, archivePath).replaceAll('\\', '/');
}

type RenderedScriptc = {
  outDir: string;
  ffiJson: string;
  declarations: string;
};

/** 공통 전처리 — 출력 디렉터리 해상도 + 신선한 스키마 로드 + 아티팩트 렌더. */
function renderScriptcPair(input: ScriptcStageInput): RenderedScriptc {
  const outDir = resolveScriptcOutDir(resolve(input.configPath, '..'), input.scriptc);
  // 렌더에는 아카이브 참조만 필요하다 — 존재 검사는 write 모드 진입(runScriptcStage)의 몫.
  const { libraryRef } = resolveScriptcArchive(input, outDir);
  const schemaPath = resolve(input.schemaOutDir, 'schema.json');
  let schemaJson: string;
  try {
    schemaJson = readFileSync(schemaPath, 'utf8');
  } catch (error) {
    throw new Error(
      `scriptc stage could not read the fresh schema at ${schemaPath}; the schema probe ` +
        `must honor RUSTRA_SCHEMA_OUT before the scriptc stage runs`,
      { cause: error },
    );
  }
  const schema = JSON.parse(schemaJson) as Parameters<typeof generateScriptcArtifacts>[0]['schema'];
  const artifacts = generateScriptcArtifacts({ schema, archivePath: libraryRef });
  return { outDir, ffiJson: artifacts.ffiJson, declarations: artifacts.declarations };
}

/**
 * write 모드 — 아카이브 존재 fail-closed 검사 후 ffi.json·scriptc-ffi.d.ts 를
 * 커밋 위치에 쓴다. 반환값은 쓴 파일 경로 목록(codegen JSON 계약의 written 와 같은
 * 절대 경로 관례).
 */
export function runScriptcStage(input: ScriptcStageInput): string[] {
  const outDir = resolveScriptcOutDir(resolve(input.configPath, '..'), input.scriptc);
  const { archivePath } = resolveScriptcArchive(input, outDir);
  if (!existsSync(archivePath)) {
    const profile = input.scriptc.profile ?? 'release';
    throw new Error(
      `scriptc staticlib archive not found: ${archivePath}. Build it first — ` +
        `cargo build --manifest-path ${input.target.manifestPath} --package ${input.target.packageName} ` +
        `--release (the ${profile} staticlib must exist for scriptc to link)`,
    );
  }
  const rendered = renderScriptcPair(input);
  mkdirSync(rendered.outDir, { recursive: true });
  const manifestPath = resolve(rendered.outDir, SCRIPTC_MANIFEST_FILE);
  const declarationsPath = resolve(rendered.outDir, SCRIPTC_DECLARATIONS_FILE);
  writeFileSync(manifestPath, rendered.ffiJson);
  writeFileSync(declarationsPath, rendered.declarations);
  input.progress(`wrote ${manifestPath}`);
  input.progress(`wrote ${declarationsPath}`);
  return [manifestPath, declarationsPath];
}

/**
 * check 모드 — 임시 스키마로 재현한 아티팩트를 커밋 파일과 바이트 비교한다
 * (checkUniffiGeneratedRs 와 같은 계약·메시지 모양). 아카이브 존재는 요구하지
 * 않는다 — 렌더는 문자열 조합이라 정적 링크 바이너리 없이도 신선도를 판정한다.
 */
export function checkScriptcStage(input: ScriptcStageInput): void {
  const rendered = renderScriptcPair(input);
  const expected: ReadonlyArray<readonly [string, string]> = [
    [SCRIPTC_MANIFEST_FILE, rendered.ffiJson],
    [SCRIPTC_DECLARATIONS_FILE, rendered.declarations],
  ];
  for (const [fileName, generated] of expected) {
    const committedPath = resolve(rendered.outDir, fileName);
    let committed: string;
    try {
      committed = readFileSync(committedPath, 'utf8');
    } catch {
      throw new Error(
        `scriptc drift (missing): ${committedPath}. Run rustra codegen --config <rustra.json> ` +
          `to generate the committed scriptc artifacts`,
      );
    }
    if (generated !== committed) {
      throw new Error(
        `scriptc drift (disk changed): ${committedPath} differs from the regenerated ` +
          `artifact. Run rustra codegen --config <rustra.json> to update the committed ` +
          `scriptc artifacts`,
      );
    }
  }
}
