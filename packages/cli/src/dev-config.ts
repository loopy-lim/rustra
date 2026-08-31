import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findCargoManifest } from './cargo.js';
import { readConfigSync } from './config.js';

/** wasm dev 타깃 엔진 빌드(Task A3)에 필요한 해석된 설정 — 엔진 crate 위치와 패키지. */
export interface ResolvedDevWasm {
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
  return dev === undefined ? undefined : { ...dev, wasm: resolved };
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
    manifestPath: (manifest ? resolve(root, manifest) : undefined) ?? manifestPath,
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
  // parityGate 기본값(true)만 채운다.
  const dev = resolveDevSection(config);
  return {
    root,
    schemaPath: resolve(root, config.schema),
    outputPath: resolve(root, config.output),
    manifestPath,
    dev,
    devWasm: resolveDevWasm(config, root, manifestPath),
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
