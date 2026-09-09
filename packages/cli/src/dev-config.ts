import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findCargoManifest } from './cargo.js';
import { readConfigSync } from './config.js';

/** wasm dev 타깃 엔진 빌드(Task A3)에 필요한 해석된 설정 — 엔진 crate 위치와 패키지. */
export interface ResolvedDevWasm {
  manifestPath: string;
  rustPackage?: string;
}

/** dylib dev 타깃 핫 코어 빌드에 필요한 해석된 설정 — wasm 과 같은 최소 쌍. */
export interface ResolvedDevDylib {
  manifestPath: string;
  rustPackage?: string;
}

export interface ResolvedDevConfig {
  root: string;
  schemaPath: string;
  outputPath: string;
  manifestPath: string;
  dev?: ReturnType<typeof resolveDevSection>;
  /** target=wasm 일 때만 존재 — wasm32 엔진 빌드의 매니페스트·패키지 해석값. */
  devWasm?: ResolvedDevWasm;
  /** target=dylib 일 때만 존재 — 네이티브 cdylib 핫 코어 빌드의 매니페스트·패키지 해석값. */
  devDylib?: ResolvedDevDylib;
}

function resolveDevSection(config: ReturnType<typeof readConfigSync>) {
  const dev = config.dev;
  const wasm = dev?.wasm;
  const resolved =
    wasm === undefined
      ? dev?.target === 'wasm'
        ? { parityGate: true }
        : undefined
      : { ...wasm, parityGate: wasm.parityGate ?? true };
  // dylib 도 같은 대상별 정규화를 한다 — 섹션 생략이 게이트 무음 스킵으로 이어지는
  // fail-open 은 wasm 에서 이미 고쳤고, dylib 스왑 거부가 같은 구멍을 다시 만들면 안 된다.
  const dylib = dev?.dylib;
  const dylibResolved =
    dylib === undefined
      ? dev?.target === 'dylib'
        ? { parityGate: true }
        : undefined
      : { ...dylib, parityGate: dylib.parityGate ?? true };
  return dev === undefined ? undefined : { ...dev, wasm: resolved, dylib: dylibResolved };
}

/**
 * wasm dev 타깃의 엔진 매니페스트 해석 — RN 어댑터가 엔진 crate 를 가리키는 것과
 * 같은 우선순위(reactNative.rustManifest → codegen.rustManifest → 상위 탐색)를
 * 따른다. 탐색이 모두 실패하면 codegen 매니페스트로 폴백한다 — 이미 존재가
 * 보장된 값이므로, wasm 오케스트레이션은 cargo metadata 단계에서 명확히 실패한다.
 */
function resolveDevWasm(
  config: ReturnType<typeof readConfigSync>,
  root: string,
  manifestPath: string,
): ResolvedDevWasm | undefined {
  if (config.dev?.target !== 'wasm') return undefined;
  const manifest = config.reactNative?.rustManifest ?? config.codegen?.rustManifest;
  const rustPackage = config.reactNative?.rustPackage ?? config.codegen?.rustPackage;
  return {
    manifestPath: manifest === undefined ? manifestPath : resolve(root, manifest),
    rustPackage,
  };
}

/**
 * dylib dev 타깃의 핫 코어 매니페스트 해석 — wasm 엔진과 같은 우선순위
 * (reactNative.rustManifest → codegen.rustManifest → 상위 탐색)를 그대로 쓴다.
 * tauri 전용 레이아웃은 reactNative 섹션이 없으므로 codegen.rustManifest 경로가
 * 주가 된다. 탐색 실패 시 codegen 매니페스트 폴백까지 wasm 과 동일 — 실패는
 * buildDylibCore 의 cargo 단계에서 loud 하게 표면화된다.
 */
function resolveDevDylib(
  config: ReturnType<typeof readConfigSync>,
  root: string,
  manifestPath: string,
): ResolvedDevDylib | undefined {
  if (config.dev?.target !== 'dylib') return undefined;
  const manifest = config.reactNative?.rustManifest ?? config.codegen?.rustManifest;
  const rustPackage = config.reactNative?.rustPackage ?? config.codegen?.rustPackage;
  return {
    manifestPath: manifest === undefined ? manifestPath : resolve(root, manifest),
    rustPackage,
  };
}

export function readDevConfig(configPath: string): ResolvedDevConfig {
  const path = resolve(configPath);
  const root = dirname(path);
  const config = readConfigSync(path);
  const manifestPath = config.codegen?.rustManifest
    ? resolve(root, config.codegen.rustManifest)
    : findCargoManifest(root);
  if (!manifestPath || !existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('codegen.rust_manifest_missing: set codegen.rustManifest in rustra.json');
  }
  // dev 섹션을 **해석된** 형태로 노출한다 — reload 오케스트레이션(parity 게이트)이
  // 재판정 없이 곧장 읽을 수 있게 기본값을 채운다. 대상별 정규화: target=wasm 이면
  // wasm 섹션 자체가 없어도 `parityGate: true` 를 채운다(게이트 기본 on — 섹션
  // 생략이 게이트 무음 스킵으로 이어지는 fail-open 을 막는다). wasm 섹션이 있으면
  // parityGate 기본값(true)만 채운다. target=dylib 도 같은 규칙을 따른다.
  const dev = resolveDevSection(config);
  return {
    root,
    schemaPath: resolve(root, config.schema),
    outputPath: resolve(root, config.output),
    manifestPath,
    dev,
    devWasm: resolveDevWasm(config, root, manifestPath),
    devDylib: resolveDevDylib(config, root, manifestPath),
  };
}

export function findRepoCli(from: string): string | null {
  let directory = from;
  for (let index = 0; index < 6; index += 1) {
    directory = dirname(directory);
    const candidate = join(directory, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function assertDirectory(path: string, label: string, hint: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`rustra dev requires ${label} at ${path}. Usage: ${hint}`);
  }
}

export function readSchemaSnapshot(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
