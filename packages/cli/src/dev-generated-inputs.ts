import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { RustInputPaths } from './dev-fingerprint.js';
import { isWithin } from './watch.js';

type GeneratedOutputs = {
  outputPath: string;
  schemaPath: string;
  uniffiMirrorPath?: string;
  uniffiBindingPath?: string;
};

/** Never infer generated ownership from a filename or its parent directory. */
function recordedFiles(output: string, manifestPath: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)) return [];
    const files: string[] = [];
    for (const file of manifest.files) {
      if (
        typeof file?.path !== 'string' ||
        !file.path ||
        isAbsolute(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        return [];
      const path = resolve(output, file.path);
      if (path === resolve(output)) return [];
      try {
        if (lstatSync(path).isDirectory()) return [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
      }
      files.push(path);
    }
    return files;
  } catch {
    // Missing, unreadable or invalid ownership must leave adjacent source visible.
    return [];
  }
}

/** Share the exact generated-file boundary between config and legacy dev. */
export function withDevGeneratedInputExclusions(
  inputs: RustInputPaths,
  outputs: GeneratedOutputs,
): RustInputPaths {
  const manifestPath = join(outputs.outputPath, '.rustra-generated.json');
  const excluded = [
    ...new Set([
      ...(inputs.excluded ?? []),
      manifestPath,
      outputs.schemaPath,
      ...recordedFiles(outputs.outputPath, manifestPath),
      ...(outputs.uniffiMirrorPath ? [outputs.uniffiMirrorPath] : []),
      // UniFFI publishes a whole tree; its output is required to be dedicated.
      ...(outputs.uniffiBindingPath ? [outputs.uniffiBindingPath] : []),
    ]),
  ].sort();
  return {
    ...inputs,
    files: inputs.files.filter((path) => !excluded.some((root) => isWithin(root, path))),
    excluded,
  };
}
