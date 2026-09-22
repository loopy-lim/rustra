import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256 } from './hash.js';
import type { GeneratedFile, GeneratedManifest } from './manifest.js';

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Preflight every removal before writing anything. Never infer ownership from a filename. */
export async function planGeneratedCleanup(
  files: GeneratedFile[],
  manifestPath: string,
  roots: string[],
): Promise<string[]> {
  let manifest: GeneratedManifest | undefined;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as GeneratedManifest;
    if (
      manifest?.schemaVersion !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.some(
        (file) => typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256),
      )
    )
      throw new Error('invalid manifest');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`Cannot verify previous generated ownership: ${manifestPath}`, {
        cause: error,
      });
  }
  const output = dirname(resolve(manifestPath));
  const expected = new Set(files.map((file) => resolve(file.path)));
  const recorded = new Map(
    (manifest?.files ?? []).map((file) => [resolve(output, file.path), file.sha256]),
  );
  const obsolete = new Set([...recorded.keys()].filter((path) => !expected.has(path)));
  // Older releases overwrote the manifest while leaving these files behind.
  // Detect that state too, but require the old manifest hash before removing it.
  for (const name of ['rkyv-codecs.ts', 'rkyv-registry.ts']) obsolete.add(resolve(output, name));
  const removable: string[] = [];
  for (const path of obsolete) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const label = `Obsolete legacy generated file ${path}`;
    const hint =
      'Preserve local edits, then restore the previous manifest or manually review and move the file before rerunning codegen.';
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`${label}: symlink or non-regular file; ${hint}`);
    const hash = recorded.get(path);
    if (!hash) throw new Error(`${label}: unrecorded ownership; ${hint}`);
    let allowed = false;
    for (const root of roots) {
      const resolvedRoot = resolve(root);
      if (!within(resolvedRoot, path)) continue;
      for (
        let directory = dirname(path);
        within(resolvedRoot, directory);
        directory = dirname(directory)
      ) {
        if ((await lstat(directory)).isSymbolicLink())
          throw new Error(`${label}: parent directory is a symlink; ${hint}`);
      }
      if (within(await realpath(root), await realpath(path))) allowed = true;
    }
    if (!allowed) throw new Error(`${label}: outside generated roots; ${hint}`);
    if (sha256(await readFile(path, 'utf8')) !== hash)
      throw new Error(`${label}: modified since generation; ${hint}`);
    removable.push(path);
  }
  return removable;
}
