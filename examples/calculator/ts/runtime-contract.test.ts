import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('host apps use generated zero-config entrypoints without local transport wiring', async () => {
  const nodeApp = await readFile('examples/calculator/apps/node-app.ts', 'utf8');
  const bunApp = await readFile('examples/calculator/apps/bun-ffi-app.ts', 'utf8');
  const tauriApp = await readFile('examples/tauri-calculator/src/app.ts', 'utf8');
  const tauriMain = await readFile('examples/tauri-calculator/src-tauri/src/main.rs', 'utf8');
  const reactNativeApp = await readFile('examples/react-native-calculator/App.tsx', 'utf8');
  const reactNativeEntry = await readFile('examples/calculator/generated/react-native.ts', 'utf8');
  const nodeEntry = await readFile('examples/calculator/generated/node.ts', 'utf8');
  const bunEntry = await readFile('examples/calculator/generated/bun.ts', 'utf8');
  const tauriEntry = await readFile('examples/calculator/generated/tauri.ts', 'utf8');
  const reactNativeMetro = await readFile(
    'examples/react-native-calculator/metro.config.js',
    'utf8',
  );

  assert.match(nodeApp, /from '..\/generated\/node\.js'/);
  assert.match(bunApp, /from '..\/generated\/bun\.js'/);
  assert.match(tauriApp, /calculator\/generated\/tauri\.js'/);
  assert.match(reactNativeApp, /from ['"]\.\/generated\/react-native['"]/);
  assert.doesNotMatch(reactNativeApp, /\b(?:configure|installRustraJSI|createFastEngine)\s*\(/);

  assert.doesNotMatch(nodeApp, /createNodeEngine|configure\(/);
  assert.doesNotMatch(bunApp, /createBunEngine|configure\(|dlopen/);
  assert.doesNotMatch(tauriApp, /createTauriEngine|configure\(/);
  assert.match(nodeEntry, /createNodeBootstrap/);
  assert.match(bunEntry, /createBunBootstrap/);
  assert.match(tauriEntry, /createTauriBootstrap/);
  assert.match(reactNativeEntry, /createRustraBootstrap/);
  assert.match(reactNativeEntry, /installRustraJSI/);
  assert.match(reactNativeMetro, /watchFolders = \[repoRoot\]/);
  assert.match(reactNativeMetro, /nodeModulesPaths/);

  assert.match(tauriMain, /rustra_calculator_example::calculator_package/);
  assert.match(tauriMain, /tauri_support::register/);
  assert.doesNotMatch(tauriMain, /value:\s*a\s*\+\s*b/);
});

test('react native runtime fixture exposes a native Rust-backed invoke module', async () => {
  const swiftModule = await readFile(
    'examples/react-native-calculator/modules/rustra-calculator/ios/RustraCalculatorModule.swift',
    'utf8',
  );
  const calculatorLib = await readFile('examples/calculator/src/lib.rs', 'utf8');

  assert.match(swiftModule, /Name\("RustraCalculator"\)/);
  assert.match(swiftModule, /AsyncFunction\("invokeRaw"\)/);
  assert.match(swiftModule, /rustra_calculator_invoke/);
  assert.match(swiftModule, /rustra_calculator_free_string/);
  assert.match(calculatorLib, /extern "C" fn rustra_calculator_invoke/);
  assert.match(calculatorLib, /get_package\(\).*invoke_json/s);
});
