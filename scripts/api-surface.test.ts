import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSurface, compareSurface, serializeSurface } from './api-surface.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rustra-api-surface-'));
  put(
    root,
    'crates/rustra/src/lib.rs',
    `mod hidden;
pub mod nested { pub type Count = u32; }
pub use hidden::{
    Widget, Service,
};
pub extern "C" fn rustra_ffi_alpha(x: u8) -> u8 { x }
`,
  );
  put(
    root,
    'crates/rustra/src/hidden.rs',
    `pub struct Widget { pub id: u32, secret: u8 }
pub trait Service { fn run(&self, value: u32) -> bool; }
impl Widget { pub fn id(&self) -> u32 { self.id } }
`,
  );
  put(
    root,
    'crates/rustra-macros/src/lib.rs',
    '#[proc_macro_derive(Widget)]\n/// doc\npub fn derive_widget(input: TokenStream) -> TokenStream { input }\n',
  );
  put(
    root,
    'packages/demo/package.json',
    JSON.stringify({
      name: '@fixture/demo',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
  );
  put(
    root,
    'packages/demo/src/index.ts',
    "export { makeWidget as create, type Widget } from './model.js';\nexport default function version(): string { return 'v1'; }\n",
  );
  put(
    root,
    'packages/demo/src/model.ts',
    'export interface Widget { id: string }\nexport function makeWidget(id: string): Widget { return { id }; }\n',
  );
  return root;
}
function withFixture(action: (root: string) => void) {
  const root = fixture();
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function hasDrift(root: string, mutate: () => void) {
  const baseline = collectSurface(root);
  mutate();
  const current = collectSurface(root);
  assert.notDeepEqual(compareSurface(current, baseline), { added: {}, removed: {}, changed: {} });
  return { baseline, current };
}
function cli(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/api-surface.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('same-name reexported TS parameters and return types drift from current source', () =>
  withFixture((root) => {
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/model.ts',
        'export interface Widget { id: string }\nexport function makeWidget(id: number): Widget | null { return null; }\n',
      ),
    );
  }));
test('reachable TS interface field and default export signatures drift', () =>
  withFixture((root) => {
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/model.ts',
        'export interface Widget { id: number }\nexport function makeWidget(id: string): Widget { return { id: 1 }; }\n',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/index.ts',
        "export { makeWidget as create, type Widget } from './model.js';\nexport default function version(): number { return 1; }\n",
      ),
    );
  }));
test('export subpaths, condition targets and subpath declarations are pinned', () =>
  withFixture((root) => {
    put(
      root,
      'packages/demo/src/extra.ts',
      'export function extra(value: string): boolean { return true; }',
    );
    const manifest = {
      name: '@fixture/demo',
      type: 'module',
      exports: { '.': './dist/index.js', './extra': './dist/extra.js' },
    };
    hasDrift(root, () => put(root, 'packages/demo/package.json', JSON.stringify(manifest)));
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/extra.ts',
        'export function extra(value: number): boolean { return true; }',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/package.json',
        JSON.stringify({ ...manifest, exports: { '.': './dist/index.js' } }),
      ),
    );
  }));
test('multiline Rust use, reexported struct fields, trait methods, impl signatures, aliases and FFI drift', () =>
  withFixture((root) => {
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/hidden.rs',
        'pub struct Widget { pub id: u64, secret: u8 }\npub trait Service { fn run(&self, value: u32) -> bool; }\nimpl Widget { pub fn id(&self) -> u32 { 1 } }',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/hidden.rs',
        'pub struct Widget { pub id: u64, secret: u8 }\npub trait Service { fn run(&self, value: u64) -> bool; }\nimpl Widget { pub fn id(&self) -> u64 { 1 } }',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/lib.rs',
        'mod hidden;\npub mod nested { pub type Count = u64; }\npub use hidden::{\n Widget as Renamed, Service,\n};\npub extern "C" fn rustra_ffi_alpha(x: u16) -> u8 { 0 }',
      ),
    );
  }));
test('Rust include files, cfg alternatives and macro declarations are collected', () =>
  withFixture((root) => {
    put(root, 'crates/rustra/src/hidden.rs', 'include!("fields.rs");');
    put(
      root,
      'crates/rustra/src/fields.rs',
      '#[cfg(feature="a")] pub struct Widget { pub id: u32 }\n#[cfg(not(feature="a"))] pub struct Widget { pub id: u64 }',
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/fields.rs',
        '#[cfg(feature="a")] pub struct Widget { pub id: u16 }\n#[cfg(not(feature="a"))] pub struct Widget { pub id: u64 }',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra-macros/src/lib.rs',
        '#[proc_macro_derive(Other)]\npub fn derive_widget(input: TokenStream) -> TokenStream { input }',
      ),
    );
  }));
test('function body-only changes and comments do not drift', () =>
  withFixture((root) => {
    const baseline = collectSurface(root);
    put(
      root,
      'packages/demo/src/model.ts',
      '// comment\nexport interface Widget { id: string }\nexport function makeWidget(id: string): Widget { return { id: id.toUpperCase() }; }\n',
    );
    put(
      root,
      'crates/rustra/src/hidden.rs',
      '// comment\npub struct Widget { pub id: u32, secret: u8 }\npub trait Service { fn run(&self, value: u32) -> bool; }\nimpl Widget { pub fn id(&self) -> u32 { 42 } }\n',
    );
    assert.deepEqual(compareSurface(collectSurface(root), baseline), {
      added: {},
      removed: {},
      changed: {},
    });
  }));
test('missing TS source and malformed Rust fail closed', () =>
  withFixture((root) => {
    rmSync(join(root, 'packages/demo/src/model.ts'));
    assert.throws(() => collectSurface(root), /model|resolve|2307/);
    put(
      root,
      'packages/demo/src/model.ts',
      'export interface Widget { id: string }\nexport function makeWidget(id: string): Widget { return { id }; }',
    );
    put(root, 'crates/rustra/src/hidden.rs', 'pub struct Widget {');
    assert.throws(() => collectSurface(root), /Rust|parse|delimiter/);
  }));
test('stale built declarations cannot hide current source drift', () =>
  withFixture((root) => {
    put(root, 'packages/demo/dist/index.d.ts', 'export declare const fake: number;');
    const baseline = collectSurface(root);
    put(root, 'packages/demo/dist/index.d.ts', 'export declare const fake: string;');
    assert.deepEqual(collectSurface(root), baseline);
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/model.ts',
        'export interface Widget { id: number }\nexport function makeWidget(id: string): Widget { return { id: 1 }; }',
      ),
    );
  }));
test('missing snapshot and old version fail without regeneration', () =>
  withFixture((root) => {
    const missing = cli(root);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /snapshot missing/);
    assert.equal(existsSync(join(root, 'api-surface/snapshot.json')), false);
    put(root, 'api-surface/snapshot.json', '{"version":0}');
    const old = cli(root);
    assert.equal(old.status, 1);
    assert.match(old.stderr, /snapshot version 0/);
  }));
test('snapshot update is stable, compare detects signature changes and rebaseline restores success', () =>
  withFixture((root) => {
    const first = cli(root, ['--update']);
    assert.equal(first.status, 0, first.stderr);
    const bytes = readFileSync(join(root, 'api-surface/snapshot.json'), 'utf8');
    assert.equal(cli(root, ['--update']).status, 0);
    assert.equal(readFileSync(join(root, 'api-surface/snapshot.json'), 'utf8'), bytes);
    assert.equal(cli(root).status, 0);
    put(
      root,
      'packages/demo/src/model.ts',
      'export interface Widget { id: number }\nexport function makeWidget(id: string): Widget { return { id: 1 }; }',
    );
    const changed = cli(root);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /API surface drift/);
    assert.equal(cli(root, ['--update']).status, 0);
    assert.equal(cli(root).status, 0);
  }));
test('real source collection is byte-stable and matches versioned snapshot', () => {
  const current = collectSurface(REPO_ROOT);
  const bytes = readFileSync(join(REPO_ROOT, 'api-surface/snapshot.json'), 'utf8');
  assert.deepEqual(compareSurface(current, JSON.parse(bytes)), {
    added: {},
    removed: {},
    changed: {},
  });
  assert.ok(serializeSurface(current) === bytes, 'snapshot version or serialization differs');
});

test('each Rust declaration contract independently triggers drift', () =>
  withFixture((root) => {
    const path = 'crates/rustra/src/hidden.rs';
    const original = `pub struct Widget { pub id: u32, secret: u8 }
pub trait Service: Send { type Output; fn run(&self, value: u32) -> bool; }
impl Widget { pub fn id(&self) -> u32 { self.id } }
pub enum Mode { One, Two(u32) }
pub type Count = u32;
pub extern "C" fn rustra_ffi_call(x: u8) -> u8 { x }
`;
    put(root, path, original);
    const baseline = collectSurface(root);
    for (const [before, after] of [
      ['pub id: u32', 'pub id: u64'],
      ['Service: Send', 'Service: Send + Sync'],
      ['type Output;', 'type Output: Send;'],
      ['value: u32', 'value: u64'],
      ['id(&self) -> u32', 'id(&self) -> u64'],
      ['Two(u32)', 'Two(u64)'],
      ['Count = u32', 'Count = u64'],
      ['(x: u8)', '(x: u16)'],
      ['-> u8', '-> u16'],
      [', secret: u8', ''],
    ]) {
      put(root, path, original.replace(before, after));
      assert.notDeepEqual(
        compareSurface(collectSurface(root), baseline),
        { added: {}, removed: {}, changed: {} },
        `${before} → ${after}`,
      );
    }
  }));
test('workspace aliases follow current declarations, including inferred types and star exports', () =>
  withFixture((root) => {
    put(
      root,
      'packages/other/package.json',
      JSON.stringify({ name: '@fixture/other', type: 'module', exports: './dist/index.js' }),
    );
    put(root, 'packages/other/src/index.ts', "export * from './inferred.js';");
    put(root, 'packages/other/src/inferred.ts', 'export function inferred() { return 1; }');
    put(root, 'packages/demo/src/index.ts', "export { inferred } from '@fixture/other';");
    put(root, 'packages/other/dist/index.d.ts', 'export declare function inferred(): boolean;');
    hasDrift(root, () =>
      put(
        root,
        'packages/other/src/inferred.ts',
        "export function inferred() { return 'changed'; }",
      ),
    );
  }));
test('unsupported wildcard exports and missing Rust module sources fail closed', () =>
  withFixture((root) => {
    put(
      root,
      'packages/demo/package.json',
      JSON.stringify({ name: '@fixture/demo', exports: { './*': './dist/*.js' } }),
    );
    assert.throws(() => collectSurface(root), /wildcard/);
    put(
      root,
      'packages/demo/package.json',
      JSON.stringify({ name: '@fixture/demo', type: 'module', exports: './dist/index.js' }),
    );
    rmSync(join(root, 'crates/rustra/src/hidden.rs'));
    assert.throws(() => collectSurface(root), /Rust source/);
  }));
test('package add and removal are detected, and conditional target ordering is pinned', () =>
  withFixture((root) => {
    const baseline = collectSurface(root);
    put(
      root,
      'packages/new/package.json',
      JSON.stringify({ name: '@fixture/new', type: 'module', exports: './dist/index.js' }),
    );
    put(root, 'packages/new/src/index.ts', 'export const ADDED = 1;');
    assert.ok(
      compareSurface(collectSurface(root), baseline).added.packageExports?.includes('packages/new'),
    );
    rmSync(join(root, 'packages/new'), { recursive: true });
    assert.deepEqual(compareSurface(collectSurface(root), baseline), {
      added: {},
      removed: {},
      changed: {},
    });
    const manifest = {
      name: '@fixture/demo',
      type: 'module',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    };
    put(root, 'packages/demo/package.json', JSON.stringify(manifest));
    assert.ok(
      compareSurface(collectSurface(root), baseline).changed.packageExports?.includes(
        'packages/demo',
      ),
    );
    rmSync(join(root, 'packages/demo'), { recursive: true });
    assert.ok(
      compareSurface(collectSurface(root), baseline).removed.packageExports?.includes(
        'packages/demo',
      ),
    );
  }));

test('Rust private aliases and constants used by public declarations cannot hide type drift', () =>
  withFixture((root) => {
    put(
      root,
      'crates/rustra/src/hidden.rs',
      'type Internal = u32;\nconst N: usize = 4;\npub fn values() -> [Internal; N] { [0; N] }',
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/hidden.rs',
        'type Internal = u64;\nconst N: usize = 4;\npub fn values() -> [Internal; N] { [0; N] }',
      ),
    );
    hasDrift(root, () =>
      put(
        root,
        'crates/rustra/src/hidden.rs',
        'type Internal = u64;\nconst N: usize = 8;\npub fn values() -> [Internal; N] { [0; N] }',
      ),
    );
  }));

test('source declaration-only exports include both ESM and CommonJS declarations', () =>
  withFixture((root) => {
    put(
      root,
      'packages/demo/src/ambient.d.mts',
      'export declare function ambient(input: string): number;',
    );
    put(
      root,
      'packages/demo/src/ambient.d.cts',
      'export declare function ambient(input: string): number;',
    );
    put(
      root,
      'packages/demo/package.json',
      JSON.stringify({
        name: '@fixture/demo',
        exports: { '.': { import: './dist/ambient.d.mts', require: './dist/ambient.d.cts' } },
      }),
    );
    hasDrift(root, () =>
      put(
        root,
        'packages/demo/src/ambient.d.cts',
        'export declare function ambient(input: number): number;',
      ),
    );
  }));

test('Rust inline literal path follows its module directory rather than a decoy sibling', () =>
  withFixture((root) => {
    put(root, 'crates/rustra/src/lib.rs', 'pub mod inline { #[path="api.rs"] pub mod api; }');
    put(root, 'crates/rustra/src/api.rs', 'pub fn public_api() -> bool { true }');
    put(root, 'crates/rustra/src/inline/api.rs', 'pub fn public_api() -> u32 { 1 }');
    hasDrift(root, () =>
      put(root, 'crates/rustra/src/inline/api.rs', 'pub fn public_api() -> u64 { 1 }'),
    );
  }));

test('source declaration files reject unresolved types and package imports', () =>
  withFixture((root) => {
    rmSync(join(root, 'packages/demo/src/index.ts'));
    for (const text of [
      'export declare function value(): CompletelyMissingType;',
      "export type Value = import('@missing/package').Missing;",
    ]) {
      put(root, 'packages/demo/src/index.d.ts', text);
      assert.throws(() => collectSurface(root), /CompletelyMissingType|Cannot find module/);
    }
  }));

test('Rust path-overridden file and inline modules retain rustc child lookup semantics', () =>
  withFixture((root) => {
    put(root, 'crates/rustra/src/lib.rs', '#[path="custom.rs"] pub mod renamed; pub mod ordinary;');
    put(root, 'crates/rustra/src/custom.rs', 'pub mod child;');
    put(root, 'crates/rustra/src/child.rs', 'pub type Value = u32;');
    put(
      root,
      'crates/rustra/src/ordinary.rs',
      '#[path="override"] pub mod inline { #[path="api.rs"] pub mod api; }',
    );
    put(root, 'crates/rustra/src/override/api.rs', 'pub type Value = u32;');
    hasDrift(root, () => put(root, 'crates/rustra/src/child.rs', 'pub type Value = u64;'));
    hasDrift(root, () => put(root, 'crates/rustra/src/override/api.rs', 'pub type Value = u64;'));
  }));
