/**
 * uniffi 코드젠 오케스트레이션 — UniFFI Kotlin/Swift 바인딩 단계의 스폰·검증을
 * cli-codegen.ts 에서 분리한 모듈이다. TS 쪽 소비자는 없다(Rust 쪽 uniffi
 * mirror 가 커밋된 uniffi_generated.rs 로 귀결) — 이 모듈은 오케스트레이트와
 * 보고만 하고 파일을 렌더하지 않는다. 단계 순서:
 *
 *   1. cargo build --features uniffi        → cdylib 산출
 *   2. cargo run --bin uniffi-bindgen ...   → Kotlin/Swift 바인딩 출력
 *   3. 산출물 존재 검증(.kt / .swift / .h / modulemap)
 *
 * 실패 계약은 스키마 프로브 단계와 같다 — 스폰 실패는 원인 출력을 그대로 흘리고
 * 문맥을 덧붙인 에러로 감싸며(wrapError 계약), 기대 산출물 부재는 fail-closed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DylibProfile, RustraUniffiConfig } from './config.js';
import { readCargoMetadata, selectHostPackage } from './cargo-metadata.js';
import { spawnInherit } from './process.js';
import { spawnCapturingStdout, pickCdylibArtifact } from './dev-dylib.js';
import { execFileSync } from 'node:child_process';
import { withBindingOutput } from './uniffi-output.js';

/** Rust 프로브가 RUSTRA_UNIFFI_OUT 에 쓰는 파일명 — 커밋 대상이기도 하다. */
export const UNIFFI_GENERATED_RS = 'uniffi_generated.rs';

/** 예제 크레이트가 노출하는 bindgen 바이너리 이름 — uniffi-bindgen fetch-bin 관례. */
export const UNIFFI_BINDGEN_BIN = 'uniffi-bindgen';

/** 호스트 플랫폼 → cdylib 확장자. 미지 플랫폼은 uniffi 단계 자체를 거절한다. */
const HOST_DYLIB_NAME: Record<NodeJS.Platform, ((stem: string) => string) | undefined> = {
  darwin: (stem) => `lib${stem}.dylib`,
  linux: (stem) => `lib${stem}.so`,
  win32: (stem) => `${stem}.dll`,
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
  netbsd: undefined,
};

/** Legacy naming utility; builds use Cargo compiler-artifact paths instead. */
export function expectedDylibPath(
  targetDirectory: string,
  libName: string,
  profile: DylibProfile,
): string {
  const naming = HOST_DYLIB_NAME[process.platform];
  if (!naming) {
    throw new Error(
      `uniffi bindings are not supported on host platform "${process.platform}" — ` +
        `the cdylib build runs on the host and must produce a dylib (.dylib/.so/.dll)`,
    );
  }
  // crate name → 파일명 규약: 하이픈은 밑줄로 치환된다(rustra-calculator-example
  // → librustra_calculator_example.dylib).
  return resolve(targetDirectory, profile, naming(libName.replace(/-/g, '_')));
}

/** config 경로 관례 — schema/output 과 같은 config 파일 위치 기준 상대경로 해상도. */
export function resolveUniffiDir(configDir: string, dir: string): string {
  return resolve(configDir, dir);
}

/** uniffi_generated.rs 의 커밋 위치 — srcOut 기본값("src")을 여기서 채운다. */
export function resolveUniffiSrcOut(configDir: string, uniffi: RustraUniffiConfig): string {
  return resolveUniffiDir(configDir, uniffi.srcOut ?? 'src');
}

export type UniffiSpawnContext = {
  /** target.manifestPath — 코드젠 타깃 크레이트의 Cargo.toml. */
  manifestPath: string;
  /** target.packageName — cdylib 와 bindgen bin 을 모두 소유하는 크레이트. */
  packageName: string;
  /** target.cwd — 스폰 CWD(스키마 프로브와 동일). */
  cwd: string;
};

/** 스폰 출력 라우팅 — 스키마 프로브가 --format json 을 판별하는 것과 같은 계약. */
export type UniffiRunOptions = {
  /** Rebuild and compare bindings without replacing the committed output. */
  check?: boolean;
  /** JSON stdout 을 기계 판독 가능하게 지키려면 'stderr'. 기본 'stdout'. */
  progressStream?: 'stdout' | 'stderr';
  /** 자식 출력 상향 — JSON 모드에서는 'stderr' 로 흘려 stdout 을 오염시키지 않는다. */
  childOutput?: 'inherit' | 'stderr';
};

/**
 * cdylib 빌드 + bindgen 실행 + 산출물 검증의 프로세스 내 시퀀스. 스폰 실패는
 * 스키마 프로브와 같은 wrapError 문맥 계약으로 감싼다. 빌드와 bindgen 을 한
 * 스폰에 섞지 않는다 — 실패 지점이 달라야 사용자가 무엇을 고칠지 안다.
 */
export async function runUniffiBindings(
  ctx: UniffiSpawnContext,
  uniffi: RustraUniffiConfig,
  bindingOutDir: string,
  options: UniffiRunOptions,
  progress: (message: string) => void,
): Promise<void> {
  await withBindingOutput(bindingOutDir, options.check ?? false, async (emptyDirectory) => {
    await generateUniffiBindings(ctx, uniffi, emptyDirectory, options, progress);
  });
}

async function generateUniffiBindings(
  ctx: UniffiSpawnContext,
  uniffi: RustraUniffiConfig,
  bindingOutDir: string,
  options: UniffiRunOptions,
  progress: (message: string) => void,
): Promise<void> {
  const profile = uniffi.dylibProfile ?? 'debug';
  progress(
    `cargo build --manifest-path ${ctx.manifestPath} --package ${ctx.packageName} ` +
      `--features uniffi${profile === 'release' ? ' --release' : ''}`,
  );
  const metadata = readCargoMetadata(ctx.manifestPath);
  const pkg = selectHostPackage(metadata, ctx.manifestPath, ctx.packageName);
  const libraries = pkg.targets.filter((target) => target.crate_types.includes('cdylib'));
  if (libraries.length !== 1)
    throw new Error(
      `uniffi requires exactly one cdylib target in ${pkg.name}; declare crate-type = ["rlib", "cdylib"]`,
    );
  let buildOutput: string;
  try {
    buildOutput = await spawnCapturingStdout(
      [
        'build',
        '--lib',
        '--message-format=json',
        '--manifest-path',
        ctx.manifestPath,
        '--package',
        ctx.packageName,
        '--features',
        'uniffi',
        ...(profile === 'release' ? ['--release'] : []),
      ],
      ctx.cwd,
      `uniffi cdylib build (${ctx.packageName}, ${profile})`,
    );
  } catch (error) {
    throw new Error(
      `uniffi cdylib build failed for ${ctx.packageName} (${ctx.manifestPath}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // cargo 가 계산한 target 디렉터리를 근원으로 — 프로필 디렉터리 재발명 금지.
  const dylibPath = pickCdylibArtifact(buildOutput, {
    name: libraries[0]!.name,
    packageId: pkg.id,
  });
  if (!dylibPath || !existsSync(dylibPath)) {
    throw new Error(
      `uniffi cdylib build did not produce ${dylibPath} — the package must declare ` +
        `crate-type "cdylib" (crate-type = ["rlib", "cdylib"]) and the ${profile} ` +
        `profile must emit the dylib`,
    );
  }
  // Cargo build.target/CARGO_BUILD_TARGET can name a mobile target. The
  // metadata-bearing library follows that configuration; bindgen must run here.
  const rustcVersion = execFileSync('rustc', ['-vV'], { cwd: ctx.cwd, encoding: 'utf8' });
  const host = /^host: (\S+)$/m.exec(rustcVersion)?.[1];
  if (!host) throw new Error('Could not determine the Rust host target for uniffi-bindgen');
  progress(
    `cargo run --target ${host} --manifest-path ${ctx.manifestPath} --package ${ctx.packageName} --bin ` +
      `${UNIFFI_BINDGEN_BIN} --features uniffi -- generate --library ${dylibPath} ` +
      `--language kotlin --language swift --out-dir ${bindingOutDir}`,
  );
  try {
    await spawnInherit(
      'cargo',
      [
        'run',
        '--target',
        host,
        '--manifest-path',
        ctx.manifestPath,
        '--package',
        ctx.packageName,
        '--bin',
        UNIFFI_BINDGEN_BIN,
        '--features',
        'uniffi',
        '--',
        'generate',
        '--library',
        dylibPath,
        '--language',
        'kotlin',
        '--language',
        'swift',
        '--out-dir',
        bindingOutDir,
      ],
      ctx.cwd,
      {
        progressLabel: `uniffi-bindgen generate (${ctx.packageName} → ${bindingOutDir})`,
        progressStream: options.progressStream ?? 'stdout',
        childOutput: options.childOutput ?? 'inherit',
      },
    );
  } catch (error) {
    throw new Error(
      `uniffi-bindgen failed for ${ctx.packageName} (library ${dylibPath}, out-dir ${bindingOutDir}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assertBindingOutputs(bindingOutDir);
}

/** out-dir 아래 파일을 재귀 수집 — bindgen 의 하위 디렉터리 관례(kotlin/, swift/) 검사용. */
function collectFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(dir);
  return found;
}

/**
 * 바인딩 산출물 fail-closed 검사 — Kotlin .kt / Swift .swift·.h·modulemap 이
 * 각각 최소 1개씩 있어야 한다. bindgen 이 조용히 0 파일을 쓰고 exit 0 하는
 * 변칙(충돌한 out-dir 등)을 성공으로 지나가게 두지 않는다.
 */
export function assertBindingOutputs(bindingOutDir: string): void {
  const files = collectFiles(bindingOutDir);
  const has = (predicate: (file: string) => boolean): boolean => files.some(predicate);
  const missing: string[] = [];
  if (!has((file) => file.endsWith('.kt'))) missing.push('Kotlin binding (*.kt)');
  if (!has((file) => file.endsWith('.swift'))) missing.push('Swift binding (*.swift)');
  if (!has((file) => file.endsWith('.h'))) missing.push('Swift C header (*.h)');
  if (!has((file) => file.endsWith('.modulemap'))) missing.push('Swift modulemap (*.modulemap)');
  if (missing.length > 0) {
    throw new Error(
      `uniffi-bindgen output at ${bindingOutDir} is incomplete — missing: ` +
        `${missing.join(', ')}. Found ${files.length} file(s); the bindgen run must ` +
        `emit Kotlin and Swift bindings for library mode`,
    );
  }
}

/** Cheap Rust mirror check only. Use --check-bindings for actual foreign-language freshness. */
export async function checkUniffiGeneratedRs(
  temporaryRsPath: string,
  committedRsPath: string,
): Promise<void> {
  let generated: string;
  try {
    generated = await readFile(temporaryRsPath, 'utf-8');
  } catch {
    throw new Error(
      `Rust codegen did not produce ${temporaryRsPath}; the generator must honor ` +
        `RUSTRA_UNIFFI_OUT in check mode`,
    );
  }
  let committed: string;
  try {
    committed = await readFile(committedRsPath, 'utf-8');
  } catch {
    throw new Error(
      `uniffi drift (missing): ${committedRsPath}. Run rustra codegen --config <rustra.json> ` +
        `to generate the committed ${UNIFFI_GENERATED_RS}`,
    );
  }
  if (generated !== committed) {
    throw new Error(
      `uniffi drift (disk changed): ${committedRsPath} differs from the regenerated ` +
        `${UNIFFI_GENERATED_RS}. Run rustra codegen --config <rustra.json> to update ` +
        `the committed file`,
    );
  }
}
