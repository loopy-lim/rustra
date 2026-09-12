#!/usr/bin/env node
// Installation examples and compatibility tables read versions from Cargo/package manifests.
// This is checkout coherence, not proof of registry publication or native runtime acceptance.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_DOCS = [
  'README.md',
  'README.ko.md',
  'docs/getting-started.md',
  'docs/getting-started.ko.md',
];
const TABLE_DOCS = ['docs/compatibility-matrix.md', 'docs/compatibility-matrix.ko.md'];
const BEGIN = '<!-- release:versions:begin -->';
const END = '<!-- release:versions:end -->';

export function readReleaseVersions(root) {
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  const workspacePackage = cargo.match(
    /^\[workspace\.package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
  )?.[1];
  const rust = workspacePackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!rust) throw new Error('Cargo.toml: missing workspace.package.version');
  const npm = {};
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const path = join(root, 'packages', name, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.private || !manifest.name?.startsWith('@rustra/')) continue;
    if (typeof manifest.version !== 'string') throw new Error(`${path}: missing version`);
    npm[manifest.name] = manifest.version;
  }
  return { rust, npm };
}

export function renderVersionTable(root) {
  const { rust, npm } = readReleaseVersions(root);
  return [
    BEGIN,
    '',
    '| Package | Manifest version |',
    '| --- | --- |',
    `| Rust workspace crates | ${rust} |`,
    ...Object.entries(npm).map(([name, version]) => `| \`${name}\` | ${version} |`),
    '',
    END,
  ].join('\n');
}

export function verifyReleaseDocs(root, { docs = INSTALL_DOCS, tables = TABLE_DOCS } = {}) {
  const { rust, npm } = readReleaseVersions(root);
  const failures = [];
  for (const rel of docs) {
    const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const cargo = line.match(
        /^\s*(rustra(?:-macros|-naming)?)\s*=\s*(?:\{\s*version\s*=\s*)?"([^"]+)"/,
      );
      if (cargo && cargo[2] !== rust)
        failures.push(
          `${rel}:${index + 1}: ${cargo[1]} must use manifest version ${rust}, got ${cargo[2]}`,
        );
      if (!/^\s*(?:bun add|npm (?:install|i|exec)|pnpm add|yarn add|bunx|npx)\b/.test(line))
        continue;
      for (const match of line.split('#')[0].matchAll(/(@rustra\/[a-z-]+)(?:@([^\s`]+))?/g)) {
        const expected = npm[match[1]];
        if (!expected || match[2] !== expected)
          failures.push(
            `${rel}:${index + 1}: install ${match[1]}@${expected ?? 'UNKNOWN PACKAGE'} (got ${match[2] ?? 'unversioned'})`,
          );
      }
    }
  }
  const expectedTable = renderVersionTable(root);
  for (const rel of tables) {
    const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END, start);
    const actual = start < 0 || end < 0 ? null : text.slice(start, end + END.length);
    // Markdown formatters pad cells. Compare cell values, retaining row order and marker presence.
    const normalize = (value) =>
      value
        .replace(/\|[ \t]+/g, '|')
        .replace(/[ \t]+\|/g, '|')
        .replace(/-{3,}/g, '---');
    if (
      actual === null ||
      normalize(actual) !== normalize(expectedTable) ||
      text.indexOf(BEGIN, start + BEGIN.length) >= 0
    ) {
      failures.push(
        `${rel}: release version table missing or stale; regenerate with node scripts/check-release-docs.mjs --print-table`,
      );
    }
  }
  return { ok: failures.length === 0, failures, checked: docs.length + tables.length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-table')) console.log(renderVersionTable(process.cwd()));
  else {
    const report = verifyReleaseDocs(process.cwd());
    if (!report.ok) {
      console.error(report.failures.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        `release-docs: ${report.checked} installation/matrix documents match manifest versions`,
      );
  }
}
