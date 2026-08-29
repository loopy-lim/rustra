import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENERATED_REACT_NATIVE_PACKAGE } from './react-native.js';
import { portablePackagePath, type HostEntries } from './host-entries.js';

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
  if (!workspaces.includes(workspacePath)) {
    manifest.workspaces = [...workspaces, workspacePath].sort();
  }
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== raw) await writeFile(manifestPath, next);
}

export async function ensureHostDependencies(
  hosts: HostEntries,
  cliVersion: string,
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
  const expected = `^${cliVersion}`;
  for (const name of required) {
    const existing = dependencies[name] ?? manifest.devDependencies?.[name];
    if (
      existing !== undefined &&
      existing !== expected &&
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
