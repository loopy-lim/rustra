import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENERATED_REACT_NATIVE_PACKAGE } from './react-native.js';
import { portablePackagePath, type HostEntries } from './host-entries.js';
import { findWorkspaceOwner, workspaceExcludes, workspaceIncludes } from './workspace-owner.js';

export async function ensureReactNativeDependency(
  appRoot: string,
  moduleDir: string,
  adapterRange: string,
): Promise<void> {
  const manifestPath = resolve(appRoot, 'package.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      'React Native setup requires package.json next to rustra.json so autolinking can see the generated module.',
    );
  }
  const manifest = JSON.parse(raw) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: string[];
  };
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const modulePath = portablePackagePath(appRoot, moduleDir);
  const workspacePath = modulePath.replace(/^\.\//, '');
  const expectedModule = 'workspace:*';
  const previousGeneratedModule = `file:${modulePath}`;
  const existingModule = dependencies[GENERATED_REACT_NATIVE_PACKAGE];
  if (
    existingModule !== undefined &&
    existingModule !== expectedModule &&
    existingModule !== previousGeneratedModule
  ) {
    throw new Error(
      `Dependency ${GENERATED_REACT_NATIVE_PACKAGE} already points to ${existingModule}; ` +
        `refusing to replace it with the generated workspace at ${workspacePath}.`,
    );
  }
  dependencies[GENERATED_REACT_NATIVE_PACKAGE] = expectedModule;
  if (
    dependencies['@rustra/react-native'] === undefined &&
    manifest.devDependencies?.['@rustra/react-native'] === undefined
  ) {
    dependencies['@rustra/react-native'] = adapterRange;
  }
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const workspaces = manifest.workspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== 'string')) {
    throw new Error('React Native setup requires package.json workspaces to be a string array');
  }
  const owner = await findWorkspaceOwner(appRoot);
  if (owner) {
    const path = portablePackagePath(owner.directory, moduleDir).replace(/^\.\//, '');
    if (workspaceExcludes(owner.patterns, path))
      throw new Error(
        `Generated module ${path} is excluded by workspaces in ${owner.path}; review that workspace configuration.`,
      );
    if (!workspaceIncludes(owner.patterns, path)) {
      const entries = [...owner.patterns, path].sort();
      owner.manifest.workspaces = owner.objectForm
        ? { ...(owner.manifest.workspaces as object), packages: entries }
        : entries;
      await writeFile(owner.path, `${JSON.stringify(owner.manifest, null, 2)}\n`);
    }
  } else if (!workspaces.includes(workspacePath)) {
    manifest.workspaces = [...workspaces, workspacePath].sort();
  }
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== raw) await writeFile(manifestPath, next);
}

// Keep the configured range or an exact stable version it admits. Do not expand
// arbitrary user ranges: that could silently accept an incompatible release line.
function acceptsDependency(existing: string, expected: string): boolean {
  if (existing === expected || existing === expected.replace(/^\^/, '')) return true;
  const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const candidate = exact.exec(existing)?.slice(1).map(Number);
  const base = expected.startsWith('^')
    ? exact.exec(expected.slice(1))?.slice(1).map(Number)
    : null;
  if (!candidate || !base || ![...candidate, ...base].every(Number.isSafeInteger)) return false;
  const compare = (left: number[], right: number[]) =>
    left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  const upper =
    base[0]! > 0
      ? [base[0]! + 1, 0, 0]
      : base[1]! > 0
        ? [0, base[1]! + 1, 0]
        : [0, 0, base[2]! + 1];
  return compare(candidate, base) >= 0 && compare(candidate, upper) < 0;
}

export async function ensureHostDependencies(
  hosts: HostEntries,
  ranges: Record<string, string>,
): Promise<void> {
  const manifestPath = resolve(hosts.appRoot, 'package.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error('Node, Bun, and Tauri setup requires package.json next to rustra.json.');
  }
  const manifest = JSON.parse(raw) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const required = [
    '@rustra/types',
    ...(hosts.node ? ['@rustra/node'] : []),
    ...(hosts.bun ? ['@rustra/bun'] : []),
    ...(hosts.tauri ? ['@rustra/tauri'] : []),
  ];
  for (const name of required) {
    const expected = ranges[name];
    if (!expected) throw new Error(`Missing compatibility range for ${name}`);
    const existing = dependencies[name] ?? manifest.devDependencies?.[name];
    if (
      existing !== undefined &&
      !acceptsDependency(existing, expected) &&
      !existing.startsWith('file:') &&
      !existing.startsWith('workspace:')
    ) {
      throw new Error(
        `Dependency ${name} already points to ${existing}; refusing to replace it with ${expected}. ` +
          'Align the Rustra release line explicitly.',
      );
    }
    if (existing === undefined) dependencies[name] = expected;
  }
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== raw) await writeFile(manifestPath, next);
}
