import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';

import { checkArchitectureBoundaries } from './architecture-boundaries.mjs';

const repositoryRoot = join(import.meta.dir, '..');

test('the repository satisfies the architecture boundaries', () => {
  const report = checkArchitectureBoundaries({ root: repositoryRoot });

  assert.deepEqual(report.errors, []);
  assert.ok(
    (report.moduleSizes.find((module) => module.path === 'crates/rustra/src/lib.rs')?.lines ??
      Infinity) <= 200,
  );
});

test('the checker reports boundary violations with stable rule ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-architecture-'));

  try {
    mkdirSync(join(root, 'crates/rustra/src'), { recursive: true });
    mkdirSync(join(root, 'crates/rustra-macros/src'), { recursive: true });
    mkdirSync(join(root, 'packages/types/src'), { recursive: true });
    mkdirSync(join(root, 'packages/node/src'), { recursive: true });
    mkdirSync(join(root, 'packages/bun/src'), { recursive: true });
    mkdirSync(join(root, 'packages/tauri/src'), { recursive: true });
    mkdirSync(join(root, 'packages/cli/src'), { recursive: true });

    writeFileSync(join(root, 'crates/rustra/src/lib.rs'), `${'// large\n'.repeat(1_301)}\n`);
    writeFileSync(join(root, 'crates/rustra-macros/src/lib.rs'), 'fn snake_to_lower_camel() {}\n');
    writeFileSync(join(root, 'crates/rustra/src/codegen.rs'), 'fn snake_to_lower_camel() {}\n');
    writeFileSync(join(root, 'packages/types/src/index.ts'), `${'// large\n'.repeat(601)}\n`);
    writeFileSync(
      join(root, 'packages/node/src/index.ts'),
      'export function createJsonEngine() {}\n',
    );
    writeFileSync(
      join(root, 'packages/bun/src/index.ts'),
      'export function createJsonEngine() {}\n',
    );
    writeFileSync(
      join(root, 'packages/tauri/src/index.ts'),
      'export function createJsonEngine() {}\n',
    );
    writeFileSync(join(root, 'packages/cli/src/index.ts'), 'setTimeout(() => {}, 100);\n');

    const report = checkArchitectureBoundaries({ root });
    const ruleIds = report.errors.map((error) => error.rule);

    assert.ok(ruleIds.includes('rustra-lib-size'));
    assert.ok(ruleIds.includes('types-index-size'));
    assert.ok(ruleIds.includes('shared-rust-naming'));
    assert.ok(ruleIds.includes('shared-json-engine'));
    assert.ok(ruleIds.includes('watcher-boundary'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checker exposes oversized implementation modules as actionable warnings', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-architecture-size-'));

  try {
    mkdirSync(join(root, 'packages/example/src'), { recursive: true });
    mkdirSync(join(root, 'crates/rustra-naming/src'), { recursive: true });
    writeFileSync(join(root, 'crates/rustra-naming/src/lib.rs'), 'fn snake_to_lower_camel() {}\n');
    writeFileSync(join(root, 'packages/example/src/large.ts'), `${'// large\n'.repeat(201)}\n`);

    const report = checkArchitectureBoundaries({ root });
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((warning) => warning.rule === 'source-module-size'));
    assert.equal(report.moduleSizes[0]?.path, 'packages/example/src/large.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checker rejects implementation modules above the hard 400-line ceiling', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-architecture-hard-size-'));

  try {
    mkdirSync(join(root, 'crates/rustra-naming/src'), { recursive: true });
    mkdirSync(join(root, 'packages/example/src'), { recursive: true });
    writeFileSync(join(root, 'crates/rustra-naming/src/lib.rs'), 'fn snake_to_lower_camel() {}\n');
    writeFileSync(join(root, 'packages/example/src/large.ts'), `${'// large\n'.repeat(401)}\n`);

    const report = checkArchitectureBoundaries({ root });
    assert.ok(report.errors.some((error) => error.rule === 'source-module-size'));
    assert.equal(
      report.errors.find((error) => error.rule === 'source-module-size')?.path,
      'packages/example/src/large.ts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
