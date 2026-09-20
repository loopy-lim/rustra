import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnInherit } from './process.js';
import type { ResolvedDevWasm } from './dev-config.js';
import { readCargoMetadata, selectHostPackage, requireTargetDirectory } from './cargo-metadata.js';

/** cargo 규약 — cdylib wasm32 릴리스 산출물 이름(lib 타깃 이름의 `-` → `_`). */
function wasmArtifactName(libName: string): string {
  return `${libName.replaceAll('-', '_')}.wasm`;
}

/**
 * wasm32 엔진 아티팩트 경로 — A0 스파이크(`scripts/build-backend.sh`)가 실제로
 * 생산하는 레이아웃을 그대로 따른다:
 * `<target_directory>/wasm32-unknown-unknown/release/<crate_name>.wasm`
 * 이름 근원은 패키지가 아니라 **lib 타깃** 이름이다 — cargo 는 cdylib 산출물
 * 이름을 `[lib] name`(지정 없으면 패키지 이름)에서 가져온다. 이 저장소의 RN
 * 관례(`lib${rustLibrary}.a`)와 같은 근원이다.
 */
export function wasmEngineArtifactPath(
  manifestPath: string,
  libName: string,
  metadata = readCargoMetadata(manifestPath),
): string {
  return join(
    requireTargetDirectory(metadata),
    'wasm32-unknown-unknown',
    'release',
    wasmArtifactName(libName),
  );
}

/**
 * wasm dev 타깃(Task A3)의 rust 재빌드 단계 — 엔진 crate 의 cdylib 를
 * wasm32-unknown-unknown 으로 빌드하고 산출물 경로를 돌려준다. 매니페스트의
 * 패키지 중 cdylib 타깃을 가진 것을 고른다(reactNative.rustPackage 지정 시 그
 * 패키지로 한정). 릴리스 프로필(`--release`)은 A0 스파이크가 검증한 구성
 * (opt-level "s", panic=abort)과 동일하다 — dev 편의 프로필을 새로 발명하지 않는다.
 */
export async function buildWasmEngine(devWasm: ResolvedDevWasm): Promise<string> {
  const manifestPath = devWasm.manifestPath;
  const metadata = readCargoMetadata(manifestPath);
  const cargoPackage = selectHostPackage(metadata, manifestPath, devWasm.rustPackage);
  const cdylibs = cargoPackage.targets.filter((target) => target.crate_types.includes('cdylib'));
  if (cdylibs.length !== 1) {
    throw new Error(
      `wasm engine build requires exactly one cdylib target in package ${cargoPackage.name}, found ${cdylibs.length}. ` +
        `Add crate-type = ["rlib", "cdylib"] to ${manifestPath}` +
        (devWasm.rustPackage ? '' : `, or set reactNative.rustPackage in rustra.json`),
    );
  }
  const artifactPath = wasmEngineArtifactPath(manifestPath, cdylibs[0]!.name, metadata);
  await spawnInherit(
    'cargo',
    ['build', '--manifest-path', manifestPath, '--target', 'wasm32-unknown-unknown', '--release'],
    dirname(manifestPath),
    {
      progressLabel: `wasm32 engine build (${cargoPackage.name})`,
      childOutput: 'inherit',
    },
  );
  if (!existsSync(artifactPath)) {
    throw new Error(
      `wasm32 build did not produce ${artifactPath} — the cdylib target must compile for wasm32-unknown-unknown`,
    );
  }
  return artifactPath;
}
