import { dirname, resolve } from 'node:path';
import { findCargoManifest } from './cargo.js';
import { readCargoMetadata, selectHostPackage } from './cargo-metadata.js';
import type { RustraConfig } from './config.js';
import { resolveCodegenTarget, selectReactNativeCargoTarget } from './host-entries.js';

export interface SetupBuild {
  manifestPath: string;
  packageName: string;
  cwd?: string;
}

/** Build each producer after generation, including hosts outside the schema crate. */
export function resolveSetupBuilds(configPath: string, config: RustraConfig): SetupBuild[] {
  const root = dirname(configPath);
  const generator = resolveCodegenTarget(configPath, config);
  const builds: SetupBuild[] = [generator];
  for (const section of [config.node, config.bun, config.reactNative]) {
    if (!section) continue;
    const manifestPath = section.rustManifest
      ? resolve(root, section.rustManifest)
      : config.codegen?.rustManifest
        ? resolve(root, config.codegen.rustManifest)
        : findCargoManifest(root);
    if (!manifestPath) throw new Error('Could not find the runtime Cargo.toml');
    const isReactNative = section === config.reactNative;
    const cwd = isReactNative ? dirname(manifestPath) : root;
    const metadata = readCargoMetadata(manifestPath, cwd);
    const packageName = isReactNative
      ? selectReactNativeCargoTarget(metadata, manifestPath, section.rustPackage).rustPackage
      : selectHostPackage(metadata, manifestPath, section.rustPackage).name;
    builds.push({ manifestPath: resolve(manifestPath), packageName, cwd });
  }
  return [
    ...new Map(
      builds.map((build) => [`${build.manifestPath}\0${build.packageName}\0${build.cwd}`, build]),
    ).values(),
  ];
}
