import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { portablePackagePath } from './host-entries.js';

import picomatch from 'picomatch';

const matches = (pattern: string, path: string): boolean =>
  picomatch.isMatch(path, pattern, { nonegate: true });
const isExclusion = (pattern: string): boolean =>
  pattern.startsWith('!') && !pattern.startsWith('!(');

export function workspaceIncludes(patterns: string[], path: string): boolean {
  const normalized = path.replace(/^\.\//, '');
  return (
    patterns.some(
      (pattern) => !isExclusion(pattern) && matches(pattern.replace(/^\.\//, ''), normalized),
    ) && !workspaceExcludes(patterns, normalized)
  );
}

export function workspaceExcludes(patterns: string[], path: string): boolean {
  return patterns.some(
    (pattern) =>
      isExclusion(pattern) &&
      matches(pattern.slice(1).replace(/^\.\//, ''), path.replace(/^\.\//, '')),
  );
}

export async function findWorkspaceOwner(appRoot: string) {
  let directory = dirname(resolve(appRoot));
  while (true) {
    const path = resolve(directory, 'package.json');
    let raw: string | undefined;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (raw !== undefined) {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const value = manifest.workspaces;
      const patterns = Array.isArray(value)
        ? value
        : (value as { packages?: unknown } | undefined)?.packages;
      if (
        Array.isArray(patterns) &&
        patterns.every((entry) => typeof entry === 'string') &&
        workspaceIncludes(patterns, portablePackagePath(directory, appRoot))
      )
        return { directory, path, manifest, patterns, objectForm: !Array.isArray(value) };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
