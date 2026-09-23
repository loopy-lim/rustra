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
  const attempted = await Promise.all(
    [...obsolete].map(async (path) => {
      try {
        return { path, stat: await lstat(path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }),
  );
  const existing = attempted.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const hint =
    'Preserve local edits, then restore the previous manifest or manually review and move the file before rerunning codegen.';

  for (const { path, stat } of existing) {
    const label = `Obsolete legacy generated file ${path}`;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`${label}: symlink or non-regular file; ${hint}`);
    if (!recorded.get(path)) throw new Error(`${label}: unrecorded ownership; ${hint}`);
  }

  const parentDirectories = new Set<string>();
  for (const { path } of existing)
    for (const root of roots) {
      const resolvedRoot = resolve(root);
      if (!within(resolvedRoot, path)) continue;
      for (
        let directory = dirname(path);
        within(resolvedRoot, directory);
        directory = dirname(directory)
      )
        parentDirectories.add(directory);
    }
  // root 는 파일 존재와 무관하게 아직 만들어지지 않았을 수 있다(첫 코드젠) —
  // 원본의 lazy realpath 와 동일하게 없는 root 는 null 로 건너뛴다.
  const [symlinkCandidateResults, realRoots, realPaths, contents] = await Promise.all([
    Promise.all(
      [...parentDirectories].map(async (directory) =>
        (await lstat(directory)).isSymbolicLink() ? directory : null,
      ),
    ),
    Promise.all(roots.map((root) => realpath(root).catch(() => null))),
    Promise.all(existing.map(({ path }) => realpath(path))),
    Promise.all(existing.map(({ path }) => readFile(path, 'utf8'))),
  ]);
  const symlinkedParents = new Set(
    symlinkCandidateResults.filter((directory): directory is string => directory !== null),
  );

  const removable: string[] = [];
  for (const [index, { path }] of existing.entries()) {
    const label = `Obsolete legacy generated file ${path}`;
    let allowed = false;
    for (const [rootIndex, root] of roots.entries()) {
      const resolvedRoot = resolve(root);
      if (!within(resolvedRoot, path)) continue;
      for (
        let directory = dirname(path);
        within(resolvedRoot, directory);
        directory = dirname(directory)
      )
        if (symlinkedParents.has(directory))
          throw new Error(`${label}: parent directory is a symlink; ${hint}`);
      const realRoot = realRoots[rootIndex];
      if (realRoot !== null && within(realRoot, realPaths[index])) allowed = true;
    }
    if (!allowed) throw new Error(`${label}: outside generated roots; ${hint}`);
    if (sha256(contents[index]) !== recorded.get(path))
      throw new Error(`${label}: modified since generation; ${hint}`);
    removable.push(path);
  }
  return removable;
}
