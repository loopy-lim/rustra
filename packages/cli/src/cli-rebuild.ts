import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosixPath } from './paths.js';

function collectFileMtimes(
  directory: string,
  suffix: string,
  root = directory,
  result = new Map<string, number>(),
): Map<string, number> {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.spec.ts')
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectFileMtimes(path, suffix, root, result);
    else if (entry.name.endsWith(suffix)) result.set(relative(root, path), statSync(path).mtimeMs);
  }
  return result;
}

export function autoRebuild(): void {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    if (toPosixPath(modulePath).includes('/src/')) return;
    const cliDir = resolve(dirname(modulePath), '..');
    const srcDir = resolve(cliDir, 'src');
    const distDir = resolve(cliDir, 'dist');
    const sourceFiles = collectFileMtimes(srcDir, '.ts');
    const distFiles = collectFileMtimes(distDir, '.js');
    const stale = [...sourceFiles].some(
      ([sourcePath, sourceMtime]) =>
        distFiles.get(`${sourcePath.slice(0, -3)}.js`) === undefined ||
        sourceMtime > distFiles.get(`${sourcePath.slice(0, -3)}.js`)!,
    );
    if (stale) {
      console.log('CLI source is newer than dist — rebuilding...');
      execSync('bun run build', { cwd: cliDir, stdio: 'pipe' });
      console.log('CLI rebuilt.');
    }
  } catch (error) {
    throw new Error(
      `CLI auto-rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
