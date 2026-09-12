import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyReleaseDocs, renderVersionTable } from './check-release-docs.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rustra-release-docs-'));
  writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.9.0"\n');
  for (const [name, version] of [
    ['types', '0.9.0'],
    ['tauri', '0.8.0'],
  ]) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@rustra/${name}`, version }),
    );
  }
  writeFileSync(
    join(root, 'README.md'),
    'rustra = "0.8"\nbun add @rustra/types@0.9.0 @rustra/tauri@0.8.0\n',
  );
  return root;
}

test('wrong Rust installation version fails then manifest-aligned docs pass', () => {
  const root = fixture();
  try {
    const before = verifyReleaseDocs(root, { docs: ['README.md'], tables: [] });
    assert.equal(before.ok, false);
    assert.match(before.failures.join('\n'), /rustra.*0\.9\.0/);
    const doc = join(root, 'README.md');
    writeFileSync(doc, readFileSync(doc, 'utf8').replace('"0.8"', '"0.9.0"'));
    assert.equal(verifyReleaseDocs(root, { docs: ['README.md'], tables: [] }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unversioned npm install and wrong independent adapter version fail', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'README.md'), 'bun add @rustra/types @rustra/tauri@0.9.0\n');
    const result = verifyReleaseDocs(root, { docs: ['README.md'], tables: [] });
    assert.equal(result.failures.length, 2);
    assert.match(result.failures.join('\n'), /@rustra\/tauri@0\.8\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compatibility table is derived from manifests and cannot disappear or drift', () => {
  const root = fixture();
  try {
    const doc = join(root, 'matrix.md');
    const table = renderVersionTable(root);
    assert.match(table, /@rustra\/tauri` \| 0\.8\.0/);
    writeFileSync(doc, table);
    assert.equal(verifyReleaseDocs(root, { docs: [], tables: ['matrix.md'] }).ok, true);
    writeFileSync(doc, table.replace('0.8.0', '0.9.0'));
    assert.equal(verifyReleaseDocs(root, { docs: [], tables: ['matrix.md'] }).ok, false);
    writeFileSync(doc, '# No table\n');
    assert.equal(verifyReleaseDocs(root, { docs: [], tables: ['matrix.md'] }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
