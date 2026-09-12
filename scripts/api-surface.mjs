// Source declaration drift gate. See api-surface/README.md for supported boundaries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTypeScript } from './api-surface-typescript.mjs';

const SNAPSHOT_VERSION = 3;
const TOOL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECTIONS = ['rustDeclarations', 'packageExports', 'packageAssets', 'tsDeclarations'];
export function collectSurface(root = process.cwd()) {
  const typescript = collectTypeScript(root);
  const result = spawnSync(
    'cargo',
    [
      'run',
      '--quiet',
      '--locked',
      '--manifest-path',
      join(TOOL_ROOT, 'scripts/api-surface-rust/Cargo.toml'),
      '--target-dir',
      join(TOOL_ROOT, 'target/api-surface-rust'),
      '--',
      resolve(root),
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Rust API collector failed: ${result.error?.message ?? result.stderr}`);
  return { rustDeclarations: JSON.parse(result.stdout), ...typescript };
}
export function serializeSurface(surface) {
  return (
    JSON.stringify(
      {
        version: SNAPSHOT_VERSION,
        ...Object.fromEntries(SECTIONS.map((key) => [key, surface[key]])),
      },
      null,
      2,
    ) + '\n'
  );
}
export function compareSurface(current, snapshot) {
  const added = {},
    removed = {},
    changed = {};
  for (const section of SECTIONS) {
    const before = snapshot[section] ?? {},
      after = current[section] ?? {};
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (!(key in before)) (added[section] ??= []).push(key);
      else if (!(key in after)) (removed[section] ??= []).push(key);
      else (changed[section] ??= []).push(key);
    }
  }
  return { added, removed, changed };
}
function run() {
  const root = process.cwd(),
    path = join(root, 'api-surface/snapshot.json');
  if (process.argv.includes('--update')) {
    const serialized = serializeSurface(collectSurface(root));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized);
    console.log('snapshot updated: api-surface/snapshot.json');
    return;
  }
  if (!existsSync(path))
    throw new Error(
      'snapshot missing: api-surface/snapshot.json — restore it or run --update intentionally',
    );
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  if (snapshot.version !== SNAPSHOT_VERSION)
    throw new Error(
      `snapshot version ${snapshot.version ?? '(missing)'} != ${SNAPSHOT_VERSION} — re-run with --update after upgrading this script`,
    );
  const drift = compareSurface(collectSurface(root), snapshot);
  if (Object.values(drift).some((sections) => Object.keys(sections).length)) {
    console.error('API surface drift detected — update intentionally via --update:');
    for (const [kind, sections] of Object.entries(drift))
      for (const [section, keys] of Object.entries(sections))
        for (const key of keys) console.error(`  ${kind} ${section}: ${key}`);
    process.exitCode = 1;
  } else console.log('OK: API surface matches snapshot');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
