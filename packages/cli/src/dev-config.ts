import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findCargoManifest } from './cargo.js';
import { readConfigSync } from './config.js';

export function readDevConfig(configPath: string) {
  const path = resolve(configPath);
  const root = dirname(path);
  const config = readConfigSync(path);
  const manifestPath = config.codegen?.rustManifest
    ? resolve(root, config.codegen.rustManifest)
    : findCargoManifest(root);
  if (!manifestPath || !existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('codegen.rust_manifest_missing: set codegen.rustManifest in rustra.json');
  }
  return {
    root,
    schemaPath: resolve(root, config.schema),
    outputPath: resolve(root, config.output),
    manifestPath,
  };
}

export function findRepoCli(from: string): string | null {
  let directory = from;
  for (let index = 0; index < 6; index += 1) {
    directory = dirname(directory);
    const candidate = join(directory, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function assertDirectory(path: string, label: string, hint: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`rustra dev requires ${label} at ${path}. Usage: ${hint}`);
  }
}

export function readSchemaSnapshot(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
