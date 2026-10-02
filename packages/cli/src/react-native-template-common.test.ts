import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderModuleIndex } from './react-native-template-common.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function runGeneratedModule(consumer: string): void {
  const root = mkdtempSync(join(tmpdir(), 'rustra-rn-installer-'));
  try {
    mkdirSync(join(root, 'node_modules/react-native'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@rustra'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules/react-native/package.json'),
      JSON.stringify({ type: 'module', exports: './index.js' }),
    );
    writeFileSync(
      join(root, 'node_modules/react-native/index.js'),
      'export const NativeModules = { RustraBridge: globalThis.fixtureInstaller };',
    );
    symlinkSync(
      join(repoRoot, 'packages/react-native'),
      join(root, 'node_modules/@rustra/react-native'),
    );
    const source = renderModuleIndex();
    writeFileSync(join(root, 'index.ts'), source);
    writeFileSync(
      join(root, 'index.mjs'),
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText,
    );
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `${setup}\n${consumer}`],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Keep the actual adapter's global lookup while mocking only the RN platform installer.
const setup = String.raw`
import assert from 'node:assert/strict';
const native = {
  invoke: () => new ArrayBuffer(0),
  invokeFrame: () => new ArrayBuffer(0),
  invokeJson: () => '{}',
};
let nativeReads = 0;
let installed = true;
Object.defineProperty(globalThis, '__rustraNative', {
  configurable: true,
  get() { nativeReads++; return installed ? native : undefined; },
});
`;

for (const result of ['false', 'Promise.resolve(false)']) {
  test(`generated RN install rejects ${result} before reading a previously installed native`, () => {
    runGeneratedModule(String.raw`
let calls = 0;
globalThis.fixtureInstaller = { install() { calls++; return ${result}; } };
const { installRustraJSI } = await import('./index.mjs');
const pending = installRustraJSI();
assert.ok(pending instanceof Promise, 'the public install API remains asynchronous');
await assert.rejects(pending, /install/i);
assert.equal(calls, 1);
assert.equal(nativeReads, 0, 'explicit false must not fall through to an old native global');
`);
  });
}

for (const async of [false, true]) {
  test(`generated RN install verifies native only after ${async ? 'async' : 'sync'} success`, () => {
    runGeneratedModule(String.raw`
installed = false;
let calls = 0;
globalThis.fixtureInstaller = {
  install: ${async ? 'async' : ''} () => {
    calls++;
    assert.equal(nativeReads, 0);
    ${async ? 'await Promise.resolve();' : ''}
    installed = true;
    return true;
  },
};
const { installRustraJSI, getRustraNative } = await import('./index.mjs');
const pending = installRustraJSI();
assert.ok(pending instanceof Promise);
assert.equal(await pending, undefined, 'public success resolves void');
assert.equal(calls, 1);
assert.equal(nativeReads, 1, 'a successful installer must verify the installed native');
assert.equal(getRustraNative(), native);
`);
  });
}

for (const async of [false, true]) {
  test(`generated RN install preserves an original ${async ? 'async' : 'sync'} native error`, () => {
    runGeneratedModule(String.raw`
const failure = new Error('controlled native install failure');
globalThis.fixtureInstaller = { install: ${async ? 'async' : ''} () => { throw failure; } };
const { installRustraJSI } = await import('./index.mjs');
await assert.rejects(installRustraJSI(), error => error === failure);
assert.equal(nativeReads, 0);
`);
  });
}
