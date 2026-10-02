import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { toPosixPath } from './paths.js';

type Dependency = { value: unknown; base: string };

export function cargoDependency(manifest: string, name: string): Dependency | undefined {
  const base = dirname(realpathSync(manifest));
  const doc = parse(readFileSync(manifest, 'utf8'));
  const dependency = (doc.dependencies as Record<string, unknown> | undefined)?.[name];
  if (dependency === undefined) return undefined;
  if (
    !dependency ||
    typeof dependency !== 'object' ||
    !('workspace' in dependency) ||
    dependency.workspace !== true
  )
    return { value: dependency, base };
  for (let directory = base; ; directory = dirname(directory)) {
    const path = join(directory, 'Cargo.toml');
    if (existsSync(path)) {
      const workspace = parse(readFileSync(path, 'utf8')).workspace as
        { dependencies?: Record<string, unknown> } | undefined;
      if (workspace) {
        const inherited = workspace.dependencies?.[name];
        if (inherited === undefined)
          throw new Error(`Missing workspace dependency ${name} in ${path}`);
        const value = typeof inherited === 'string' ? { version: inherited } : inherited;
        if (!value || typeof value !== 'object')
          throw new Error(`Invalid workspace dependency ${name} in ${path}`);
        const overrides = { ...dependency } as Record<string, unknown>;
        delete overrides.workspace;
        const features = [
          ...((value as { features?: string[] }).features ?? []),
          ...((overrides.features as string[] | undefined) ?? []),
        ];
        return {
          value: { ...value, ...overrides, ...(features.length ? { features } : {}) },
          base: directory,
        };
      }
    }
    if (dirname(directory) === directory)
      throw new Error(`Cannot resolve workspace dependency ${name} in ${manifest}`);
  }
}

export function dependencyManifest(dependency: Dependency | undefined): string | undefined {
  const value = dependency?.value;
  if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string')
    return undefined;
  const manifest = resolve(dependency!.base, value.path, 'Cargo.toml');
  return existsSync(manifest) ? realpathSync(manifest) : undefined;
}

export function rustraDependencyLine(
  dependency: Dependency | undefined,
  nativeRoot: string,
  fallback: string,
): string {
  const original = dependency?.value;
  const value: Record<string, unknown> =
    typeof original === 'string'
      ? { version: original }
      : { ...((original as object | undefined) ?? { version: fallback }) };
  if (typeof value.path === 'string')
    value.path = toPosixPath(
      relative(realpathSync(nativeRoot), resolve(dependency!.base, value.path)),
    );
  delete value.optional;
  value.features = [...new Set([...((value.features as string[] | undefined) ?? []), 'tauri'])];
  return `rustra = { ${Object.entries(value)
    .map(
      ([key, item]) =>
        `${/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(item)}`,
    )
    .join(', ')} }`;
}
