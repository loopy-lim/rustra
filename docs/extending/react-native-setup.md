# React Native Setup Guide

## Overview

rustra-bridge supports React Native via a native module (Expo Module) that bridges Rust through JSI. This guide covers setting up the iOS transport with a static Rust library.

> **Status:** iOS is supported. Android (Kotlin/JNI) is not yet implemented.

## Architecture

```
TypeScript (your app)
  → ReactNativeEngineClient
    → Expo Module (Swift/JSI)
      → Rust FFI (static lib)
```

## iOS Setup

### 1. Build the Rust static library

Each native module needs a build script that cross-compiles your Rust crate for the iOS target:

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

### 3. Create the Expo Module

`expo-module.config.json`:

```json
{
  "platforms": ["ios"],
  "ios": { "modules": ["RustraCalculatorModule"] }
}
```

The Swift module calls Rust FFI directly:

```swift
@objc(RustraCalculatorModule)
public class RustraCalculatorModule: ExpoModule {
  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")
    AsyncFunction("invokeRaw") { (payload: String, promise: Promise) in
      let resultPtr = rustra_calculator_invoke(payload)
      // ... handle result, free with rustra_calculator_free_string
    }
  }
}
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
rustra generate \
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
import { NativeModules } from 'react-native';
import { createReactNativeEngine } from '@rustra/react-native';

const engine = createReactNativeEngine(NativeModules.RustraCalculator);

// Invoke commands
const result = await engine.invoke<AddNumbersOutput>('addNumbers', { a: 1, b: 2 });
```

### Types

The engine client is type-safe:

```typescript
type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

## Android Setup

Android support requires a Kotlin module with JNI bindings to the Rust library. This is on the roadmap but not yet implemented.

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
2. Run `npx expo-modules-core` to regenerate module providers
3. Clean build: `cd ios && pod deintegrate && pod install`
