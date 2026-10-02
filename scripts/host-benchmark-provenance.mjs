import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error('Could not record benchmark source tree');
  return result.stdout;
}

export function collectBenchmarkSource(root) {
  const paths = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) =>
        /^(crates|packages|examples|scripts)\//.test(path) ||
        /^(Cargo\.(toml|lock)|bun\.lock|package\.json|rust-toolchain\.toml)$/.test(path),
    )
    .filter((path) =>
      /\.(rs|ts|js|mjs|json|toml|lock|cpp|hpp|h|inc|mm|m|swift|kt|java|sh|podspec)$/.test(path),
    )
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(`${path}\0`);
    const absolute = resolve(root, path);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : 'deleted\0');
  }
  return {
    sourceSha: git(root, ['rev-parse', 'HEAD']).trim(),
    sourceDirty: git(root, ['status', '--porcelain']).length > 0,
    sourceTreeHash: hash.digest('hex'),
    sourceFileCount: paths.length,
  };
}

export function benchmarkArtifact(root, path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return null;
  return { path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
}
