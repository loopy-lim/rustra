import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSurface, compareSurface, serializeSurface } from './api-surface.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rustra-api-surface-'));
  mkdirSync(join(root, 'crates', 'rustra', 'src'), { recursive: true });
  mkdirSync(join(root, 'crates', 'rustra-macros', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'other', 'src'), { recursive: true });

  writeFileSync(
    join(root, 'crates', 'rustra', 'src', 'lib.rs'),
    [
      'pub mod alpha;',
      'pub mod beta;',
      'mod hidden;',
      'pub(crate) mod internal;',
      '',
      'pub use other_crate::reexported;',
      'pub(crate) use hidden::thing;',
      'pub use hidden::{ThingOne, ThingTwo};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'crates', 'rustra', 'src', 'ffi_core.rs'),
    [
      '#[unsafe(no_mangle)]',
      'pub unsafe extern "C" fn rustra_ffi_alpha() -> u32 {',
      '    0',
      '}',
      '',
      'pub extern "C" fn rustra_ffi_beta(x: u8) -> u8 {',
      '    x',
      '}',
      '',
    ].join('\n'),
  );
  // macro_rules! 내부의 extern "C" fn 은 크레이트 자체 export 가 아니므로 제외돼야 한다.
  writeFileSync(
    join(root, 'crates', 'rustra', 'src', 'entry.rs'),
    [
      '#[macro_export]',
      'macro_rules! mobile_entry {',
      '    ($package:path $(,)?) => {',
      '        #[unsafe(no_mangle)]',
      '        pub extern "C" fn rustra_mobile_init() {',
      '            let _ = $package();',
      '        }',
      '    };',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'crates', 'rustra-macros', 'src', 'lib.rs'),
    [
      '#[proc_macro]',
      'pub fn build(input: TokenStream) -> TokenStream {',
      '    input',
      '}',
      '',
      '#[proc_macro_attribute]',
      'pub fn bridge_type(attr: TokenStream, item: TokenStream) -> TokenStream {',
      '    item',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'demo', 'src', 'index.ts'),
    [
      '/** demo package. */',
      "export * from './core.js';",
      "export * as extras from './extras.js';",
      "export type { Alpha, Beta } from './types.js';",
      'export interface Widget {',
      '  id: string;',
      '}',
      'export function makeWidget(): Widget {',
      "  return { id: 'w' };",
      '}',
      "export const VERSION = '1.0.0';",
      'export class Registry {}',
      'export { helperOne, helperTwo };',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'other', 'src', 'index.ts'),
    ["export * from './more.js';", 'export const OTHER = 1;', ''].join('\n'),
  );
  return root;
}

test('collectSurface extracts rust modules, ffi exports, macros, and ts exports', () => {
  const root = makeFixture();
  try {
    const surface = collectSurface(root);
    assert.deepEqual(surface.rustModules, [
      'pub mod alpha',
      'pub mod beta',
      'pub use hidden::{ThingOne, ThingTwo}',
      'pub use other_crate::reexported',
    ]);
    assert.deepEqual(surface.ffiExports, ['rustra_ffi_alpha', 'rustra_ffi_beta']);
    assert.deepEqual(surface.macros, ['bridge_type', 'build']);
    assert.deepEqual(surface.tsExports['packages/demo'], [
      "* as extras from './extras.js'",
      "* from './core.js'",
      'Alpha',
      'Beta',
      'Registry',
      'VERSION',
      'Widget',
      'helperOne',
      'helperTwo',
      'makeWidget',
    ]);
    assert.deepEqual(surface.tsExports['packages/other'], ["* from './more.js'", 'OTHER']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectSurface is deterministic across runs', () => {
  const root = makeFixture();
  try {
    assert.deepEqual(collectSurface(root), collectSurface(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareSurface reports exactly the added and removed exports', () => {
  const root = makeFixture();
  try {
    const snapshot = JSON.parse(serializeSurface(collectSurface(root)));
    writeFileSync(
      join(root, 'packages', 'demo', 'src', 'index.ts'),
      [
        "export * from './core.js';",
        "export * as extras from './extras.js';",
        "export type { Alpha, Beta } from './types.js';",
        'export interface Widget {',
        '  id: string;',
        '}',
        'export function makeWidget(): Widget {',
        "  return { id: 'w' };",
        '}',
        "export const VERSION = '1.0.0';",
        'export class Registry {}',
        'export { helperOne, anotherHelper };',
        '',
      ].join('\n'),
    );
    const drift = compareSurface(collectSurface(root), snapshot);
    assert.deepEqual(drift.added, { 'tsExports[packages/demo]': ['anotherHelper'] });
    assert.deepEqual(drift.removed, { 'tsExports[packages/demo]': ['helperTwo'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareSurface detects a whole package removal and a whole package addition', () => {
  const root = makeFixture();
  try {
    const snapshot = JSON.parse(serializeSurface(collectSurface(root)));
    // 패키지 통째로 삭제 — removed 에 잡혀야 한다 (exit 1 근거).
    rmSync(join(root, 'packages', 'other', 'src', 'index.ts'));
    const removal = compareSurface(collectSurface(root), snapshot);
    assert.deepEqual(removal.added, {});
    assert.deepEqual(removal.removed, {
      'tsExports[packages/other]': ["* from './more.js'", 'OTHER'],
    });
    // 복원 후 반대 방향: 스냅샷엔 없던 패키지가 생김 — added 에 잡혀야 한다.
    mkdirSync(join(root, 'packages', 'fresh', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'fresh', 'src', 'index.ts'), 'export const NEW = 1;\n');
    writeFileSync(
      join(root, 'packages', 'other', 'src', 'index.ts'),
      ["export * from './more.js';", 'export const OTHER = 1;', ''].join('\n'),
    );
    const addition = compareSurface(collectSurface(root), snapshot);
    assert.deepEqual(addition.added, { 'tsExports[packages/fresh]': ['NEW'] });
    assert.deepEqual(addition.removed, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'api-surface.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('--update output is byte-stable across runs and matches the committed snapshot', () => {
  const root = makeFixture();
  try {
    const first = runCli(['--update'], root);
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(join(root, 'api-surface', 'snapshot.json'));
    const second = runCli(['--update'], root);
    assert.equal(second.status, 0, second.stderr);
    const secondBytes = readFileSync(join(root, 'api-surface', 'snapshot.json'));
    assert.ok(firstBytes.equals(secondBytes), '--update is not byte-stable');
    // 커밋된 스냅샷도 스크립트 출력과 byte 일치 — 스크립트가 유일한 포맷 진실원.
    const committed = readFileSync(join(REPO_ROOT, 'api-surface', 'snapshot.json'));
    const expected = Buffer.from(serializeSurface(collectSurface(REPO_ROOT)), 'utf8');
    assert.ok(committed.equals(expected), 'committed snapshot differs from script output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real repo snapshot exists and matches a fresh collection', () => {
  const snapshotPath = join(REPO_ROOT, 'api-surface', 'snapshot.json');
  assert.ok(existsSync(snapshotPath), 'api-surface/snapshot.json is missing');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(collectSurface(REPO_ROOT), snapshot);
});
