import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CargoBinaryTarget = {
  name: string;
  kind?: string[];
  crate_types?: string[];
};

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** Finds the nearest Cargo manifest for a config or app directory. */
export function findCargoManifest(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const candidate = resolve(current, 'Cargo.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function cargoPackagesForManifest<T extends { name?: string; manifest_path?: string }>(
  packages: T[],
  manifestPath: string,
  requestedPackage?: string,
): T[] {
  const manifest = canonicalPath(manifestPath);
  return packages.filter((candidate) => {
    if (requestedPackage) return candidate.name === requestedPackage;
    return (
      candidate.manifest_path !== undefined && canonicalPath(candidate.manifest_path) === manifest
    );
  });
}

/** Single Cargo binary-selection policy shared by codegen and doctor. */
export function selectCodegenBinary(
  targets: CargoBinaryTarget[],
  requested?: string,
  preferredNames: readonly string[] = ['generate'],
): string {
  const binaries = targets.filter(
    (target) => target.kind?.includes('bin') || target.crate_types?.includes('bin'),
  );
  const selected = requested
    ? binaries.find((target) => target.name === requested)
    : (preferredNames
        .map((name) => binaries.find((target) => target.name === name))
        .find((target): target is CargoBinaryTarget => target !== undefined) ??
      (binaries.length === 1 ? binaries[0] : undefined));
  if (!selected) {
    const names =
      binaries
        .map((target) => target.name)
        .sort()
        .join(', ') || 'none';
    throw new Error(`codegen.rust_binary_ambiguous: found ${names}; set codegen.rustBinary`);
  }
  return selected.name;
}
