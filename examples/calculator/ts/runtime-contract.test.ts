import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('host apps share generated commands and differ only by adapter transport', async () => {
  const nodeApp = await readFile('examples/calculator/apps/node-app.ts', 'utf8');
  const bunApp = await readFile('examples/calculator/apps/bun-app.ts', 'utf8');
  const tauriApp = await readFile('examples/tauri-calculator/src/app.ts', 'utf8');
  const tauriMain = await readFile('examples/tauri-calculator/src-tauri/src/main.rs', 'utf8');
  const reactNativeApp = await readFile('examples/react-native-calculator/App.tsx', 'utf8');
  const reactNativeMetro = await readFile('examples/react-native-calculator/metro.config.js', 'utf8');

  assert.match(nodeApp, /from '..\/generated\/commands\.js'/);
  assert.match(bunApp, /from '..\/generated\/commands\.js'/);
  assert.match(tauriApp, /from '..\/..\/calculator\/generated\/commands\.js'/);
  assert.match(reactNativeApp, /from ['"].*calculator\/generated\/commands['"]/);

  assert.match(nodeApp, /createNodeEngine/);
  assert.match(bunApp, /createBunEngine/);
  assert.match(tauriApp, /createTauriEngine/);
  assert.match(reactNativeApp, /createReactNativeEngine/);
  assert.match(reactNativeApp, /RustraCalculatorModule/);
  assert.match(reactNativeMetro, /watchFolders = \[repoRoot\]/);
  assert.match(reactNativeMetro, /nodeModulesPaths/);

  assert.match(tauriMain, /rustra_calculator_example::\{calculator_package/);
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
  assert.match(calculatorLib, /calculator_package\(\)\.invoke_json/);
});
