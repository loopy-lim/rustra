import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { cargoPackagesForManifest } from './cargo.js';

export type CargoMetadata = {
  target_directory?: string;
  packages: Array<{
    name: string;
    manifest_path: string;
    targets: Array<{ name: string; crate_types: string[]; kind?: string[] }>;
  }>;
};

const cache = new Map<string, { mtimeMs: number; size: number; metadata: CargoMetadata }>();

/**
 * 감사 #9 후반 — cargo 바이너리 부재(ENOENT)만 rustup 설치 안내를 덧붙인다.
 * 매니페스트 파일 부재도 ENOENT 이므로 path === 'cargo' 로 실행 파일만 골라내야
 * "설치하라"는 오안내를 피한다. 나머지 실패는 원인 문맥만 남긴다.
 */
export function describeCargoMetadataError(manifestPath: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  const missingBinary =
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT' &&
    (error as NodeJS.ErrnoException).path === 'cargo';
  const hint = missingBinary
    ? ' — cargo was not found on PATH. Install Rust with https://rustup.rs'
    : '';
  return `Could not inspect ${manifestPath} with cargo metadata: ${cause}${hint}`;
}

export function readCargoMetadata(manifestPath: string): CargoMetadata {
  try {
    const cargoToml = realpathSync(resolve(manifestPath));
    const manifestStat = statSync(cargoToml);
    if (basename(cargoToml) !== 'Cargo.toml' || !manifestStat.isFile()) {
      throw new Error('rustManifest must point to a regular Cargo.toml file');
    }
    const previous = cache.get(cargoToml);
    if (
      previous &&
      previous.mtimeMs === manifestStat.mtimeMs &&
      previous.size === manifestStat.size
    ) {
      return previous.metadata;
    }
    const output = execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', cargoToml],
      { encoding: 'utf8' },
    );
    const metadata = JSON.parse(output) as CargoMetadata;
    cache.set(cargoToml, { mtimeMs: manifestStat.mtimeMs, size: manifestStat.size, metadata });
    return metadata;
  } catch (error) {
    throw new Error(describeCargoMetadataError(manifestPath, error), { cause: error });
  }
}

export function selectHostPackage(
  metadata: CargoMetadata,
  manifestPath: string,
  requested?: string,
) {
  const candidates = cargoPackagesForManifest(metadata.packages, manifestPath, requested);
  if (candidates.length !== 1) {
    const names =
      candidates
        .map((candidate) => candidate.name)
        .sort()
        .join(', ') || 'none';
    throw new Error(
      requested
        ? `Cargo package ${requested} was not found uniquely in ${manifestPath}`
        : `Host setup found ${candidates.length} Cargo packages (${names}). Point rustManifest at the app crate, or set the host rustPackage.`,
    );
  }
  return candidates[0]!;
}

export function requireTargetDirectory(metadata: CargoMetadata): string {
  if (!metadata.target_directory) throw new Error('cargo metadata did not return target_directory');
  return resolve(metadata.target_directory);
}
