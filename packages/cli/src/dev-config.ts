import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findCargoManifest } from './cargo.js';
import { readConfigSync } from './config.js';

export function readDevConfig(configPath: string) {
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
  const dev = config.dev;
  const wasm = dev?.wasm;
  const resolved =
    wasm === undefined
      ? dev?.target === 'wasm'
        ? { parityGate: true }
        : undefined
      : { ...wasm, parityGate: wasm.parityGate ?? true };
  return {
    root,
    schemaPath: resolve(root, config.schema),
    outputPath: resolve(root, config.output),
    manifestPath,
    dev: dev === undefined ? undefined : { ...dev, wasm: resolved },
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
