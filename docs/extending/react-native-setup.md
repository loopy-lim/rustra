# React Native Setup Guide

## Overview

rustra-bridge supports React Native via a native module that bridges Rust through JSI. This guide covers setting up the iOS and Android transports with a static Rust library.

> **Status:** the repository calculator proves the shared C++ bridge builds on
> iOS and Android, and its Android Release APK contains arm64/x86_64 native
> libraries. `@rustra/react-native` is a JS adapter, not a prebuilt native
> module. Consumers must adapt the reference module to their own Rust crate and
> symbols. Build/link proof is not the same as install/launch/runtime proof.

## Architecture

```
TypeScript (your app)
  → ReactNativeEngineClient
    → Native module (JSI, shared C++)
      → Rust FFI (static lib per platform)
```

## iOS Setup

### 1. Build the Rust static library

Each native module needs a build script that cross-compiles your Rust crate for the iOS target.
The command below uses the calculator reference script; a different crate must parameterize
the crate and library names rather than copy them unchanged:

```sh
# From your module directory
RUSTRA_IOS_TARGET=aarch64-apple-ios-sim ./ios/build-rust-ios.sh
```

The script:

- Compiles your crate as a static library (`--lib --release`)
- Copies `lib<crate_name>.a` into `ios/rust/lib/`

### 2. Configure the Podspec

Your module's `.podspec` must link the Rust static library:

```ruby
s.vendored_libraries = 'rust/lib/librustra_calculator_example.a'
s.pod_target_xcconfig = {
  'OTHER_LDFLAGS' => '-force_load $(PODS_TARGET_SRCROOT)/rust/lib/librustra_calculator_example.a'
}
```

### 3. Create the Expo JSI Module

`expo-module.config.json`:

```json
{
  "platforms": ["ios"],
  "ios": { "modules": ["RustraJSIModule"] }
}
```

The production fast path is installed by the Objective-C++ JSI Expo module. The
example's separate Swift `RustraCalculatorModule` is a benchmark-only direct FFI
comparator:

```objc
AsyncFunction(@"install") {
  // Obtain the React Native runtime + CallInvoker and call rustra::install(...).
  // See examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIModule.mm.
};
```

### 4. Metro config for monorepo

If your RN app lives inside a monorepo, configure Metro to resolve shared packages:

```js
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = ['../../..']; // monorepo root
module.exports = config;
```

## Usage

### C++ codec generation (`--cpp-output`)

The JSI fast path (B1) uses C++ postcard codecs compiled into the native module,
which removes the ~3.4µs JS-side codec round trip. Generate them alongside the
TS codecs:

```sh
bunx --bun rustra generate \
  --schema ./generated/schema.json \
  --output ./src/generated \
  --cpp-output ./ios
```

This emits `rustra-generated-codecs.{hpp,cpp}` into `./ios` — commit them next
to `RustraJSIBridge.cpp` and add the `.cpp` to the Xcode/Podspec and Gradle
sources. iOS and Android share the same C++ source. Commands whose fields the
postcard codec does not support are excluded from the C++ dispatch and fall
back to the JS Tier 3 (JSON-in-binary) path automatically.

### TypeScript side

```typescript
import { configure, createFastEngine, getRustraNative } from '@rustra/react-native';
import { installRustraJSI } from 'your-rustra-native-module';
import { rkyvV2Registry } from './generated/rkyv-registry.js';

await installRustraJSI();
configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));

const result = await addNumbers({ a: 1, b: 2 });
```

### Types

The engine client is type-safe:

```typescript
type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T>;
};
```

## Android Setup

Android shares the same C++ JSI bridge as iOS — the module wiring is the
only platform-specific part.

### 1. Build the Rust static libraries (per ABI)

The module's `build-rust-android.sh` cross-compiles your crate for both
device ABIs with a pinned NDK. The Gradle hook invokes it automatically, or
you can run it directly:

```sh
cd modules/rustra-jsi/android
NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006 ./build-rust-android.sh
```

The script:

- Compiles your crate as a static library for `aarch64-linux-android` and
  `x86_64-linux-android` (pinned NDK — the API level is set there)
- Copies `lib<crate_name>.a` into `android/src/main/jniLibs/…`

### 2. Gradle + CMake wiring

`android/build.gradle` of the module:

```gradle
android {
  externalNativeBuild {
    cmake { path "CMakeLists.txt" }
  }
  // Rust 빌드 훅 — Gradle sync 시 build-rust-android.sh 가 실행된다.
  sourceSets {
    main {
      jniLibs.srcDirs = ['src/main/jniLibs']
    }
  }
}
tasks.preBuild {
  dependsOn "buildRust"
}
```

`CMakeLists.txt` compiles the shared C++ bridge (`RustraJSIBridge.cpp`,
generated codecs) into `librustrajsi.so` and links the Rust static libs.

### 3. JNI entry point

`rustra-jsi-jni.cpp` installs the same JSI host object on load — the JS side
(`installRustraJSI()` followed by `createFastEngine(getRustraNative(), ...)`)
is identical to iOS.

### Verify

The repo example runs a full Release build in CI. This proves build/link and
APK packaging, not emulator installation or rendered command output:

```sh
cd examples/react-native-calculator
bunx --bun expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease -x lint
unzip -l app/build/outputs/apk/release/app-release.apk | grep librustrajsi
```

## Troubleshooting

### "library not found for -lrustra\_..."

Run the Rust build script before `pod install`:

```sh
./ios/build-rust-ios.sh && cd ios && pod install
```

### Metro can't resolve @rustra/react-native

Ensure `watchFolders` in `metro.config.js` points to the monorepo root.

### "RustraCalculator" is undefined

Verify the Expo module is properly linked:

1. Check `expo-module.config.json` references the correct Swift class
2. Run `bunx --bun expo-modules-core` to regenerate module providers
3. Clean build: `cd ios && pod deintegrate && pod install`
