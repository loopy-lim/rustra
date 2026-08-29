import { dirname, relative, resolve } from 'node:path';
import type { ReactNativeScaffoldOptions } from './react-native.js';
import { cargoPackagesForManifest, findCargoManifest, selectCodegenBinary } from './cargo.js';
import { toPosixPath } from './paths.js';
import type { RustraConfig } from './config.js';
import {
  readCargoMetadata,
  requireTargetDirectory,
  selectHostPackage,
  type CargoMetadata,
} from './cargo-metadata.js';

export type CargoHostEntry = { targetDirectoryUrl: string; targetName: string };
export type HostEntries = {
  appRoot: string;
  node?: CargoHostEntry & { args?: string[] };
  bun?: CargoHostEntry;
  tauri?: true;
};
export type { CargoMetadata } from './cargo-metadata.js';

export function resolveCodegenTarget(configPath: string, config: RustraConfig) {
  const cwd = dirname(resolve(configPath));
  const manifestPath = config.codegen?.rustManifest
    ? resolve(cwd, config.codegen.rustManifest)
    : findCargoManifest(cwd);
  if (!manifestPath)
    throw new Error('codegen.rust_manifest_missing: set codegen.rustManifest in rustra.json');
  const metadata = readCargoMetadata(manifestPath);
  const candidates = cargoPackagesForManifest(
    metadata.packages,
    manifestPath,
    config.codegen?.rustPackage,
  );
  if (candidates.length !== 1) {
    const names =
      candidates
        .map((candidate) => candidate.name)
        .sort()
        .join(', ') || 'none';
    throw new Error(`codegen.rust_package_ambiguous: found ${names}; set codegen.rustPackage`);
  }
  const packageInfo = candidates[0]!;
  return {
    manifestPath: resolve(manifestPath),
    packageName: packageInfo.name,
    binaryName: selectCodegenBinary(packageInfo.targets, config.codegen?.rustBinary),
    cwd,
  };
}

export function selectReactNativeCargoTarget(
  metadata: CargoMetadata,
  manifestPath: string,
  requestedPackage?: string,
) {
  const manifestPackages = cargoPackagesForManifest(metadata.packages, manifestPath);
  const candidates = requestedPackage
    ? metadata.packages.filter((candidate) => candidate.name === requestedPackage)
    : manifestPackages.length > 0
      ? manifestPackages
      : metadata.packages.filter((candidate) =>
          candidate.targets.some((target) => target.crate_types.includes('staticlib')),
        );
  if (candidates.length !== 1) {
    const names =
      candidates
        .map((candidate) => candidate.name)
        .sort()
        .join(', ') || 'none';
    throw new Error(
      requestedPackage
        ? `Cargo package ${requestedPackage} was not found uniquely in ${manifestPath}`
        : `React Native setup found ${candidates.length} static-library crates (${names}). Point rustManifest at the app crate, or set reactNative.rustPackage.`,
    );
  }
  const selected = candidates[0]!;
  const staticLibraries = selected.targets.filter((target) =>
    target.crate_types.includes('staticlib'),
  );
  if (staticLibraries.length !== 1) {
    throw new Error(
      `Cargo package ${selected.name} must expose exactly one staticlib target. Add crate-type = ["rlib", "staticlib"] under [lib].`,
    );
  }
  return { rustPackage: selected.name, rustLibrary: staticLibraries[0]!.name };
}

export function resolveHostEntries(
  config: RustraConfig,
  configPath: string,
  outputPath: string,
): HostEntries | undefined {
  if (!config.node && !config.bun && !config.tauri) return undefined;
  const appRoot = dirname(resolve(configPath));
  const entries: HostEntries = { appRoot };
  if (config.node) {
    const manifest = config.node.rustManifest
      ? resolve(appRoot, config.node.rustManifest)
      : findCargoManifest(appRoot);
    if (!manifest) throw new Error('Node setup could not find Cargo.toml. Set node.rustManifest.');
    const metadata = readCargoMetadata(manifest);
    const cargoPackage = selectHostPackage(metadata, manifest, config.node.rustPackage);
    const binaries = cargoPackage.targets.filter(
      (target) => target.kind?.includes('bin') || target.crate_types.includes('bin'),
    );
    const name = selectCodegenBinary(binaries, config.node.rustBinary, [
      cargoPackage.name,
      'generate',
    ]);
    entries.node = {
      targetDirectoryUrl: `${portablePackagePath(outputPath, requireTargetDirectory(metadata))}/`,
      targetName: name,
      args: config.node.args,
    };
  }
  if (config.bun) {
    const manifest = config.bun.rustManifest
      ? resolve(appRoot, config.bun.rustManifest)
      : findCargoManifest(appRoot);
    if (!manifest) throw new Error('Bun setup could not find Cargo.toml. Set bun.rustManifest.');
    const metadata = readCargoMetadata(manifest);
    const cargoPackage = selectHostPackage(metadata, manifest, config.bun.rustPackage);
    const libraries = cargoPackage.targets.filter((target) =>
      target.crate_types.includes('cdylib'),
    );
    const selected = config.bun.rustLibrary
      ? libraries.find((target) => target.name === config.bun!.rustLibrary)
      : libraries.length === 1
        ? libraries[0]
        : undefined;
    if (!selected)
      throw new Error(
        `Bun setup requires one Cargo cdylib (${libraries
          .map((target) => target.name)
          .sort()
          .join(', ')}). Add crate-type = ["rlib", "cdylib"], or set bun.rustLibrary.`,
      );
    entries.bun = {
      targetDirectoryUrl: `${portablePackagePath(outputPath, requireTargetDirectory(metadata))}/`,
      targetName: selected.name,
    };
  }
  if (config.tauri) entries.tauri = true;
  return entries;
}

export function resolveReactNativeScaffold(
  config: RustraConfig,
  configPath: string,
  adapterRange: string,
): ReactNativeScaffoldOptions {
  const rn = config.reactNative!;
  const appRoot = dirname(resolve(configPath));
  const moduleDir = resolve(appRoot, rn.moduleDir ?? 'modules/rustra-bridge');
  if (moduleDir !== appRoot && !moduleDir.startsWith(`${appRoot}/`))
    throw new Error('Config reactNative.moduleDir must stay inside the app directory');
  const rustManifestPath = rn.rustManifest
    ? resolve(appRoot, rn.rustManifest)
    : findCargoManifest(appRoot);
  if (!rustManifestPath)
    throw new Error(
      'React Native setup could not find Cargo.toml. Set reactNative.rustManifest in rustra.json.',
    );
  const inferred = selectReactNativeCargoTarget(
    readCargoMetadata(rustManifestPath),
    rustManifestPath,
    rn.rustPackage,
  );
  return {
    appRoot,
    moduleDir,
    cppOutputPath: config.cppOutput
      ? resolve(appRoot, config.cppOutput)
      : resolve(moduleDir, 'generated'),
    rustManifestPath,
    rustPackage: inferred.rustPackage,
    rustLibrary: rn.rustLibrary ?? inferred.rustLibrary,
    adapterRange,
    legacyBenchmarks: rn.legacyBenchmarks,
  };
}

export function portablePackagePath(from: string, to: string): string {
  const path = toPosixPath(relative(from, to));
  return path.startsWith('.') ? path : `./${path}`;
}
