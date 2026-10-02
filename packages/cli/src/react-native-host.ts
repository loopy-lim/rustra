import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findReactNativeAdapterNative, GENERATED_REACT_NATIVE_PACKAGE } from './react-native.js';

type HostOptions = { appRoot: string; moduleDir: string };
type Manifest = Record<string, unknown> & {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

async function readManifest(appRoot: string) {
  const path = join(resolve(appRoot), 'package.json');
  const raw = await readFile(path, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    throw new Error(`React Native setup requires a package.json object at ${path}`);
  }
  for (const name of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'scripts',
  ] as const) {
    const section = manifest[name];
    if (
      section !== undefined &&
      (!section ||
        Array.isArray(section) ||
        typeof section !== 'object' ||
        Object.values(section).some((value) => typeof value !== 'string'))
    ) {
      throw new Error(
        `React Native setup requires package.json ${name} to be an object of strings at ${path}`,
      );
    }
  }
  return { path, raw, manifest };
}

/** Bootstrap only the adapter dependency; codegen retains native-module ownership. */
export async function ensureReactNativeAdapter(
  options: HostOptions & { adapterRange: string },
): Promise<{ changedFiles: string[]; needsInstall: boolean }> {
  const { path, raw, manifest } = await readManifest(options.appRoot);
  const needsInstall = !findReactNativeAdapterNative(options.appRoot, options.adapterRange);
  const sections = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies];
  const generated = sections.some((section) => section?.[GENERATED_REACT_NATIVE_PACKAGE]);
  if (needsInstall && generated && !existsSync(join(options.moduleDir, 'package.json'))) {
    throw new Error(
      `Generated React Native package is missing at ${options.moduleDir}, while package.json already depends on ${GENERATED_REACT_NATIVE_PACKAGE}. ` +
        'Restore that generated workspace before installing, or explicitly remove its stale dependency and rerun setup. Existing files were preserved.',
    );
  }
  if (sections.some((section) => section?.['@rustra/react-native'] !== undefined)) {
    return { changedFiles: [], needsInstall };
  }
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    '@rustra/react-native': options.adapterRange,
  };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== raw) await writeFile(path, next);
  return { changedFiles: next === raw ? [] : [path], needsInstall };
}

export type ReactNativeHostPreparation = {
  changedFiles: string[];
  scripts: { name: string; command: string }[];
  conflicts: { name: string; current: string; expected: string }[];
  followup: string[];
};

/** Add explicit, local native preparation scripts without replacing user commands. */
export async function prepareReactNativeHost(
  options: HostOptions,
): Promise<ReactNativeHostPreparation> {
  const artifact = join(resolve(options.moduleDir), 'scripts/prepare-native.cjs');
  if (!existsSync(artifact)) {
    throw new Error(
      `Generated native preparation entry is missing at ${artifact}. Run rustra codegen first, then rerun setup.`,
    );
  }
  const { path, raw, manifest } = await readManifest(options.appRoot);
  const scripts = ['ios', 'android'].map((platform) => ({
    name: `rustra:${platform}`,
    command: `node -e "require('@rustra/generated-react-native/scripts/prepare-native.cjs').prepare('${platform}')"`,
  }));
  const conflicts: ReactNativeHostPreparation['conflicts'] = [];
  const current = { ...(manifest.scripts ?? {}) };
  let added = false;
  for (const script of scripts) {
    if (current[script.name] !== undefined && current[script.name] !== script.command) {
      conflicts.push({
        name: script.name,
        current: current[script.name]!,
        expected: script.command,
      });
    } else if (current[script.name] === undefined) {
      current[script.name] = script.command;
      added = true;
    }
  }
  manifest.scripts = current;
  const next = added ? `${JSON.stringify(manifest, null, 2)}\n` : raw;
  if (next !== raw) await writeFile(path, next);
  return {
    changedFiles: next === raw ? [] : [path],
    scripts,
    conflicts,
    followup: [
      'Run rustra:ios to prepare Pods, or rustra:android to build the debug APK. These commands do not install or launch an app.',
      'Then rebuild/launch the native app with its existing React Native or Expo command and import typed commands from the generated react-native entry. Expo Go cannot load Rustra JSI.',
    ],
  };
}
