import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

export const GENERATED_REACT_NATIVE_PACKAGE = '@rustra/generated-react-native';

export type ReactNativeScaffoldOptions = {
  appRoot: string;
  moduleDir: string;
  cppOutputPath: string;
  rustManifestPath: string;
  rustPackage: string;
  rustLibrary: string;
  adapterVersion: string;
  legacyBenchmarks?: boolean;
};

function portableRelative(from: string, to: string): string {
  const value = relative(from, to).split(sep).join('/');
  return value.length === 0 ? '.' : value;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderModuleIndex(): string {
  return `import { NativeModules } from 'react-native';
import { getRustraNative as getInstalledNative } from '@rustra/react-native';

type Installer = { install(): Promise<boolean | void> };

function nativeInstaller(): Installer {
  const current = NativeModules.RustraBridge as Installer | undefined;
  if (!current) {
    throw new Error(
      '[rustra:autolink] RustraBridge was not linked. Run ' +
        '\`bunx --bun react-native config\` to inspect bare RN autolinking, then ' +
        '\`cd ios && pod install\` or rebuild Android. Expo Go cannot load JSI; Expo apps need a development build.',
    );
  }
  return current;
}

export async function installRustraJSI(): Promise<void> {
  await nativeInstaller().install();
  getInstalledNative();
}

export function getRustraNative(): ReturnType<typeof getInstalledNative> {
  return getInstalledNative();
}
`;
}

export function renderReactNativeModule(
  options: ReactNativeScaffoldOptions,
): Record<string, string> {
  const moduleRoot = resolve(options.moduleDir);
  const adapterNative = resolve(options.appRoot, 'node_modules/@rustra/react-native/native');
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
  const cmakeLegacy = options.legacyBenchmarks ? 'ON' : 'OFF';

  const packageJson = `${JSON.stringify(
    {
      name: GENERATED_REACT_NATIVE_PACKAGE,
      version: '0.0.0',
      private: true,
      type: 'module',
      main: 'src/index.ts',
      'react-native': 'src/index.ts',
      peerDependencies: {
        '@rustra/react-native': `^${options.adapterVersion}`,
        'react-native': '>=0.76',
      },
    },
    null,
    2,
  )}\n`;

  const reactNativeConfig = `module.exports = {
  dependency: {
    platforms: {
      ios: { podspecPath: './RustraBridge.podspec' },
      android: {
        sourceDir: './android',
        packageImportPath: 'import dev.rustra.bridge.RustraBridgePackage;',
        packageInstance: 'new RustraBridgePackage()',
      },
    },
  },
};
`;

  const podspec = `Pod::Spec.new do |s|
  s.name = 'RustraBridge'
  s.version = '0.0.0'
  s.summary = 'Generated Rustra JSI bridge'
  s.author = 'Rustra contributors'
  s.homepage = 'https://github.com/loopy-lim/rustra'
  s.license = 'MIT'
  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.static_framework = true

  adapter_root = File.expand_path('${adapterFromIos}', __dir__)
  generated_root = File.expand_path('${generatedFromIos}', __dir__)
  rust_archive = 'ios/rust/lib/lib${options.rustLibrary}.a'

  s.prepare_command = 'sh ios/build-rust-ios.sh'
  s.vendored_libraries = rust_archive
  s.source_files = 'ios/RustraBridge*.{mm,cpp}'
  s.dependency 'React-jsi'
  s.dependency 'React-Core'
  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => "$(inherited) #{adapter_root}/cpp #{adapter_root}/ios #{generated_root}",
${legacyDefinition}    'OTHER_LDFLAGS' => "$(inherited) -force_load $(PODS_TARGET_SRCROOT)/#{rust_archive}",
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
end
`;

  const iosBuild = `#!/bin/sh
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST_PATH="$MODULE_DIR/${manifestFromModule}"
PACKAGE=${shellSingleQuoted(options.rustPackage)}
LIBRARY=${shellSingleQuoted(options.rustLibrary)}
TARGET_DIR="$MODULE_DIR/build/target"
CARGO_BIN=\${CARGO_BIN:-cargo}
PROFILE=\${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then REL_FLAG="--release"; fi
mkdir -p "$MODULE_DIR/ios/rust/lib"

build_target() {
  "$CARGO_BIN" build --manifest-path "$MANIFEST_PATH" -p "$PACKAGE" --lib \\
    $REL_FLAG --target-dir "$TARGET_DIR" --target "$1"
}

if [ -n "\${RUSTRA_IOS_TARGET:-}" ]; then
  build_target "$RUSTRA_IOS_TARGET"
  cp "$TARGET_DIR/$RUSTRA_IOS_TARGET/$PROFILE/lib$LIBRARY.a" \\
    "$MODULE_DIR/ios/rust/lib/lib$LIBRARY.a"
else
  build_target aarch64-apple-ios-sim
  build_target x86_64-apple-ios
  lipo -create \\
    "$TARGET_DIR/aarch64-apple-ios-sim/$PROFILE/lib$LIBRARY.a" \\
    "$TARGET_DIR/x86_64-apple-ios/$PROFILE/lib$LIBRARY.a" \\
    -output "$MODULE_DIR/ios/rust/lib/lib$LIBRARY.a"
fi
`;

  const androidBuild = `#!/bin/sh
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST_PATH="$MODULE_DIR/${manifestFromModule}"
PACKAGE=${shellSingleQuoted(options.rustPackage)}
LIBRARY=${shellSingleQuoted(options.rustLibrary)}
TARGET_DIR="$MODULE_DIR/build/target"
CARGO_BIN=\${CARGO_BIN:-cargo}
PROFILE=\${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then REL_FLAG="--release"; fi
ABIS=\${ANDROID_ABIS:-"x86_64-linux-android aarch64-linux-android"}

# cargo-ndk gives ANDROID_NDK_HOME precedence over the SDK. Repair a common
# shell setup where that variable accidentally points at the SDK root.
if [ ! -f "\${ANDROID_NDK_HOME:-}/source.properties" ]; then
  for SDK_ROOT in "\${ANDROID_HOME:-}" "\${ANDROID_SDK_ROOT:-}"; do
    [ -d "$SDK_ROOT/ndk" ] || continue
    for NDK_ROOT in "$SDK_ROOT"/ndk/*; do
      [ -f "$NDK_ROOT/source.properties" ] || continue
      ANDROID_NDK_HOME="$NDK_ROOT"
    done
  done
  export ANDROID_NDK_HOME
fi

for TARGET in $ABIS; do
  "$CARGO_BIN" ndk -t "$TARGET" build --manifest-path "$MANIFEST_PATH" \\
    -p "$PACKAGE" --lib $REL_FLAG --target-dir "$TARGET_DIR"
  case "$TARGET" in
    x86_64-linux-android) ABI=x86_64 ;;
    aarch64-linux-android) ABI=arm64-v8a ;;
    armv7-linux-androideabi) ABI=armeabi-v7a ;;
    i686-linux-android) ABI=x86 ;;
    *) ABI="$TARGET" ;;
  esac
  OUT="$MODULE_DIR/android/src/main/cpp/libs/$ABI"
  mkdir -p "$OUT"
  cp "$TARGET_DIR/$TARGET/$PROFILE/lib$LIBRARY.a" "$OUT/lib$LIBRARY.a"
done
`;

  const gradle = `import javax.inject.Inject
import org.gradle.process.ExecOperations

buildscript {
  repositories { google(); mavenCentral() }
  dependencies {
    classpath "com.android.tools.build:gradle:8.7.2"
    classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20"
  }
}

apply plugin: "com.android.library"
apply plugin: "kotlin-android"

def extOr = { name, fallback -> rootProject.ext.has(name) ? rootProject.ext.get(name) : fallback }
def adapterRoot = file(${JSON.stringify(adapterFromAndroid)}).canonicalFile
def generatedRoot = file(${JSON.stringify(generatedFromAndroid)}).canonicalFile
def rustManifest = file(${JSON.stringify(`../${manifestFromModule}`)}).canonicalFile
def rustLibsDir = file("src/main/cpp/libs")

abstract class RustraExecOperations {
  @Inject abstract ExecOperations getExecOperations()
}
def rustraExec = objects.newInstance(RustraExecOperations)

android {
  namespace = "dev.rustra.bridge"
  compileSdk = extOr("compileSdkVersion", 36)
  ndkVersion = extOr("ndkVersion", "27.1.12297006")
  defaultConfig {
    minSdk = extOr("minSdkVersion", 24)
    targetSdk = extOr("targetSdkVersion", 36)
    externalNativeBuild.cmake {
      cppFlags "-std=c++20"
      arguments "-DANDROID_STL=c++_shared",
        "-DRUSTRA_ADAPTER_ROOT=$adapterRoot",
        "-DRUSTRA_GENERATED_ROOT=$generatedRoot",
        "-DRUSTRA_LIB_NAME=${options.rustLibrary}",
        "-DRUSTRA_LEGACY_BENCHMARKS=${cmakeLegacy}"
    }
    ndk { abiFilters "x86_64", "arm64-v8a" }
  }
  externalNativeBuild.cmake.path = file("CMakeLists.txt")
  buildFeatures.prefab = true
  packagingOptions.excludes = ["**/libc++_shared.so"]
  sourceSets.main.java.srcDirs = ["src/main/java"]
}

tasks.register("buildRustAndroid") {
  inputs.files(fileTree(rustManifest.parentFile) {
    include "**/*.rs", "**/Cargo.toml", "Cargo.lock"
    exclude "target/**", "**/node_modules/**", "**/build/**"
  })
  inputs.property("profile", gradle.startParameter.taskNames.any {
    it.toLowerCase().contains("release")
  } ? "release" : "debug")
  outputs.dir(rustLibsDir)
  outputs.cacheIf { true }
  doLast {
    def release = gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") }
    rustraExec.execOperations.exec {
      workingDir projectDir
      environment "RUSTRA_PROFILE", release ? "release" : "debug"
      commandLine "sh", "build-rust-android.sh"
    }
  }
}
preBuild.dependsOn "buildRustAndroid"

repositories { google(); mavenCentral() }
dependencies { implementation "com.facebook.react:react-android" }
`;

  const cmake = `cmake_minimum_required(VERSION 3.18.1)
project(rustra_bridge)
set(CMAKE_CXX_STANDARD 20)

find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)

add_library(rustra_static STATIC IMPORTED)
set_target_properties(rustra_static PROPERTIES
  IMPORTED_LOCATION \${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/libs/\${ANDROID_ABI}/lib\${RUSTRA_LIB_NAME}.a)

add_library(rustra_bridge SHARED
  \${RUSTRA_ADAPTER_ROOT}/android/rustra-jsi-jni.cpp
  \${RUSTRA_ADAPTER_ROOT}/cpp/RustraJSIBridge.cpp
  \${RUSTRA_GENERATED_ROOT}/rustra-generated-codecs.cpp)

target_include_directories(rustra_bridge PRIVATE
  \${RUSTRA_ADAPTER_ROOT}/cpp
  \${RUSTRA_GENERATED_ROOT})
if(RUSTRA_LEGACY_BENCHMARKS)
  target_compile_definitions(rustra_bridge PRIVATE RUSTRA_ENABLE_LEGACY_BENCHMARKS=1)
endif()
target_link_libraries(rustra_bridge PRIVATE
  rustra_static fbjni::fbjni ReactAndroid::jsi ReactAndroid::reactnative android log)
`;

  const androidModule = `package dev.rustra.bridge

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

class RustraBridgeModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  companion object { init { System.loadLibrary("rustra_bridge") } }

  override fun getName(): String = "RustraBridge"
  override fun invalidate() {
    nativeInvalidate()
    super.invalidate()
  }

  @ReactMethod
  fun install(promise: Promise) {
    val pointer = reactApplicationContext.javaScriptContextHolder?.get()
    if (pointer == null || pointer == 0L) {
      promise.reject("ERR_NO_RUNTIME", "JavaScript context pointer is null")
      return
    }
    if (nativeInstall(pointer, reactApplicationContext.jsCallInvokerHolder)) {
      promise.resolve(true)
    } else {
      promise.reject("ERR_INSTALL", "Failed to install Rustra onto the JSI runtime")
    }
  }

  private external fun nativeInstall(pointer: Long, holder: CallInvokerHolder?): Boolean
  private external fun nativeInvalidate()
}
`;

  const androidPackage = `package dev.rustra.bridge

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class RustraBridgePackage : ReactPackage {
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(RustraBridgeModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

  return {
    'package.json': packageJson,
    'react-native.config.js': reactNativeConfig,
    'src/index.ts': renderModuleIndex(),
    'RustraBridge.podspec': podspec,
    'ios/RustraBridge.cpp':
      '#include "RustraJSIBridge.cpp"\n#include "rustra-generated-codecs.cpp"\n',
    'ios/RustraBridgeModule.mm': '#include "RustraJSIModule.mm"\n',
    'ios/build-rust-ios.sh': iosBuild,
    'android/build.gradle': gradle,
    'android/CMakeLists.txt': cmake,
    'android/build-rust-android.sh': androidBuild,
    'android/src/main/AndroidManifest.xml':
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />\n',
    'android/src/main/java/dev/rustra/bridge/RustraBridgeModule.kt': androidModule,
    'android/src/main/java/dev/rustra/bridge/RustraBridgePackage.kt': androidPackage,
  };
}

export async function writeReactNativeModule(
  options: ReactNativeScaffoldOptions,
): Promise<string[]> {
  const files = renderReactNativeModule(options);
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const target = resolve(options.moduleDir, name);
    let old: string | undefined;
    try {
      old = await readFile(target, 'utf8');
    } catch {
      // New file.
    }
    if (old === content) {
      written.push(`${name} (unchanged)`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(old === undefined ? name : `${name} (updated)`);
  }
  return written;
}
