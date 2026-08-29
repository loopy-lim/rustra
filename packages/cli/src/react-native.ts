import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { renderAndroidBuild, renderIosBuild } from './react-native-template-scripts.js';
import {
  renderAndroidModule,
  renderAndroidPackage,
  renderCmake,
  renderGradle,
} from './react-native-template-android.js';
import {
  renderModuleIndex,
  renderPackageJson,
  renderPodspec,
  renderReactNativeConfig,
} from './react-native-template-common.js';

export const GENERATED_REACT_NATIVE_PACKAGE = '@rustra/generated-react-native';
const NATIVE_FILES = [
  'android/rustra-jsi-jni.cpp',
  'cpp/RustraJSIBridge.cpp',
  'cpp/RustraJSIBridge.hpp',
  'cpp/rustra-codec.hpp',
  'ios/RustraJSIModule.mm',
] as const;

export type ReactNativeScaffoldOptions = {
  appRoot: string;
  moduleDir: string;
  cppOutputPath: string;
  rustManifestPath: string;
  rustPackage: string;
  rustLibrary: string;
  adapterRange: string;
  legacyBenchmarks?: boolean;
};

function portableRelative(from: string, to: string): string {
  const value = relative(from, to).split(sep).join('/');
  return value.length === 0 ? '.' : value;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function satisfiesAdapterRange(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  const match = /^(\^|~|=)?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range.trim());
  if (!candidate || !match) return false;
  const base: [number, number, number] = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
  ];
  const compare = (left: [number, number, number], right: [number, number, number]) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  if (match[1] === '^') {
    const upper: [number, number, number] =
      base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return compare(candidate, base) >= 0 && compare(candidate, upper) < 0;
  }
  if (match[1] === '~')
    return compare(candidate, base) >= 0 && compare(candidate, [base[0], base[1] + 1, 0]) < 0;
  if (match[1] === '=') return compare(candidate, base) === 0;
  return match[4] === undefined
    ? candidate[0] === base[0] && candidate[1] === base[1]
    : compare(candidate, base) === 0;
}

function resolveReactNativeAdapterNative(appRoot: string, adapterRange: string): string {
  let searchRoot = resolve(appRoot);
  const rejected: string[] = [];
  while (true) {
    const packageRoot = resolve(searchRoot, 'node_modules/@rustra/react-native');
    const candidate = resolve(packageRoot, 'native');
    if (NATIVE_FILES.every((file) => existsSync(resolve(candidate, file)))) {
      try {
        const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (
          manifest.name === '@rustra/react-native' &&
          manifest.version &&
          satisfiesAdapterRange(manifest.version, adapterRange)
        )
          return candidate;
        rejected.push(
          `${packageRoot} (version ${manifest.version ?? 'unknown'}, expected ${adapterRange})`,
        );
      } catch {
        rejected.push(
          `${packageRoot} (package.json is missing or invalid, expected ${adapterRange})`,
        );
      }
    }
    const parent = dirname(searchRoot);
    if (parent === searchRoot) break;
    searchRoot = parent;
  }
  if (rejected.length > 0)
    throw new Error(
      `Found a complete but incompatible @rustra/react-native package: ${rejected.join('; ')}. Install a version satisfying ${adapterRange} and regenerate.`,
    );
  return resolve(appRoot, 'node_modules/@rustra/react-native/native');
}

export function renderReactNativeModule(
  options: ReactNativeScaffoldOptions,
): Record<string, string> {
  const moduleRoot = resolve(options.moduleDir);
  const adapterNative = resolveReactNativeAdapterNative(options.appRoot, options.adapterRange);
  const adapterFromIos = portableRelative(moduleRoot, adapterNative);
  const generatedFromIos = portableRelative(moduleRoot, options.cppOutputPath);
  const adapterFromAndroid = portableRelative(resolve(moduleRoot, 'android'), adapterNative);
  const generatedFromAndroid = portableRelative(
    resolve(moduleRoot, 'android'),
    options.cppOutputPath,
  );
  const manifestFromModule = portableRelative(moduleRoot, options.rustManifestPath);
  const legacyDefinition = options.legacyBenchmarks
    ? "    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) RUSTRA_ENABLE_LEGACY_BENCHMARKS=1',\n"
    : '';
  const values = {
    adapterFromIos,
    generatedFromIos,
    adapterFromAndroid,
    generatedFromAndroid,
    manifestFromModule,
    rustPackage: options.rustPackage,
    rustLibrary: options.rustLibrary,
    cmakeLegacy: options.legacyBenchmarks ? 'ON' : 'OFF',
    legacyDefinition,
  };
  return {
    'package.json': renderPackageJson(options.adapterRange),
    'react-native.config.js': renderReactNativeConfig(),
    'src/index.ts': renderModuleIndex(),
    'RustraBridge.podspec': renderPodspec(values),
    'ios/RustraBridge.cpp':
      '#include "RustraJSIBridge.cpp"\n#include "rustra-generated-codecs.cpp"\n',
    'ios/RustraBridgeModule.mm': '#include "RustraJSIModule.mm"\n',
    'ios/build-rust-ios.sh': renderIosBuild(values),
    'android/build.gradle': renderGradle(values),
    'android/CMakeLists.txt': renderCmake(),
    'android/build-rust-android.sh': renderAndroidBuild(values),
    'android/src/main/AndroidManifest.xml':
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />\n',
    'android/src/main/java/dev/rustra/bridge/RustraBridgeModule.kt': renderAndroidModule(),
    'android/src/main/java/dev/rustra/bridge/RustraBridgePackage.kt': renderAndroidPackage(),
  };
}
