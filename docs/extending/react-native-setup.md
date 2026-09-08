English | [한국어](./react-native-setup.ko.md)

# React Native Setup Guide

Rustra uses the same generated native package for Expo development builds and
bare React Native. You do not edit the app's Podfile, Gradle settings,
`MainApplication`, or CMake by hand.

## 1. Prepare the Rust crate

Build the static library the mobile app links against, and export package
initialization as a one-liner.

```toml
[lib]
crate-type = ["rlib", "staticlib"]
```

```rust
use rustra::prelude::*;

pub fn app_package() -> Package {
    rustra::build!("app.example", add_numbers).done()
}

rustra::native_entry!(app_package);
```

`native_entry!` creates the platform-neutral `rustra_mobile_init` ABI and, on
Apple platforms, registers the package automatically at library load time. You
never copy app-specific function names into C++.

## 2. App configuration

A typical single-crate app only needs `reactNative: {}`.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

If the Cargo workspace has multiple staticlib crates, narrow the manifest down
to the app crate.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "reactNative": {
    "rustManifest": "../native/Cargo.toml"
  }
}
```

Add `rustPackage` only when the manifest itself points at multiple packages.
The library target name is inferred from Cargo metadata, so `rustLibrary` is
usually unnecessary.

## 3. Generation and installation

Run all JavaScript work with Bun 1.4 or later.

```bash
bun add @rustra/react-native @rustra/types
bun add -d @rustra/cli
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli codegen --config rustra.json
bun install
```

By default, generation produces the following layout.

```text
generated/
  react-native.ts
  commands.ts
  rkyv-registry.ts
modules/rustra-bridge/
  package.json
  react-native.config.js
  RustraBridge.podspec
  ios/
  android/
  generated/
```

If the `@rustra/generated-react-native` workspace dependency in `package.json`
points somewhere else, the generator fails instead of overwriting. This
fail-closed behavior prevents accidental collisions with an existing package.

## 4. App code

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 1, b: 2 });
```

The first call performs native install, contract verification, and fast engine
configuration exactly once. After a reload it reinstalls into the new
JavaScript runtime, and concurrent first calls share a single bootstrap.

## 5. bare React Native

Make sure the React Native CLI can find the generated module's iOS Podspec and
Android source directory.

```bash
bunx --bun react-native config
cd ios && pod install
```

Then rebuild the app as usual. A Metro reload alone does not pick up static
archive or JSI symbol changes.

The `examples/react-native-bare-calculator` fixture in this repository
validates TypeScript and autolinking on both platforms with RN 0.81, without
the Expo package.

## 6. Expo

Expo Go cannot include arbitrary JSI native modules, so a development build is
required.

```bash
bunx --bun expo prebuild --platform ios --no-install
bunx --bun expo run:ios
```

The generated module uses React Native autolinking, so no Expo module config
or manual Podfile declaration is needed.

## 7. Verification

```bash
bun run typecheck
bunx --bun react-native config
```

The repository examples provide these additional gates.

```bash
cd examples/react-native-calculator
bun run codegen
bun run test
bun run test:cpp-codec
bun run verify:native:android
bun run verify:native:ios
```

CI verifies `librustra_bridge.so` in the Android Release APK and the iOS
Release workspace link after a clean Expo prebuild. Because build/link success
is independent of running on a real device, you should also verify generated
command results on a simulator/device before a product release.

## Collision Avoidance Contract

- JS package: `@rustra/generated-react-native`
- native module: `RustraBridge`
- Android namespace: `dev.rustra.bridge`
- Android library: `rustra_bridge`
- stable Rust initializer: `rustra_mobile_init`

## Calling rustra from C++ (TurboModule interop)

Other C++ TurboModules (or any native code on the JS runtime thread) can invoke
rustra directly with `jsi::Value` — no JS round-trip, no JSON marshalling. The
public entry points in `RustraJSIBridge.hpp` share the exact path used by the
JS-side `__rustraNative.invokeTyped*`:

```cpp
#include <RustraJSIBridge.hpp>

// JS runtime thread only (same thread-affinity contract as installRustraJSI).
// No installRustraJSI call required — only the FFI global package registration.
rustra::TypedInvokeResult result =
    rustra::invokeTypedById(runtime, commandId, argsValue);

switch (result.status) {
  case rustra::TypedInvokeStatus::Ok:            // result.value — decoded output
    break;
  case rustra::TypedInvokeStatus::NoStaticCodec: // fall back to invokeRkyvV2
    break;
  case rustra::TypedInvokeStatus::CommandError:  // result.value: {code, message}
    break;                                       // (e.g. platform.unavailable)
  case rustra::TypedInvokeStatus::MalformedResponse:
    break;                                       // result.message has details
}
```

The encoder reads fields via `getProperty`, so any `jsi::Value` shaped like the
command input works — including objects produced by other C++ TurboModules.
These functions never throw; classify outcomes by `TypedInvokeStatus`.

Adjacent interop surfaces:

- **folly::dynamic input** — `RustraTurboInterop.hpp` adds
  `invokeTypedByNameDynamic`/`invokeTypedByIdDynamic` overloads that convert a
  `folly::dynamic` to `jsi::Value` and reuse the same path (int64 beyond 2^53
  loses precision — see the header contract).
- **Binary channels** — `createChannelBytes(callback)` (JS: `createBytesChannel`)
  delivers channel payloads as `ArrayBuffer` copies — rkyv V2 frames without
  JSON serialization. Same handle/close contract as JSON channels; one handle
  works on exactly one path.
- **Synchronous invoke** — `invokeTypedSync(name, args)` (from
  `@rustra/react-native`) calls the C++ typed fast path without a Promise hop
  for UI hot paths; loud-fails with `sync.unavailable` where unavailable.

## Troubleshooting

If you see `RustraBridge was not linked`, check in this order: `bun run
codegen`, `bun install`, `bunx --bun react-native config`; on iOS, reinstall
Pods and rebuild the native app.

An ambiguous Cargo package error is resolved by narrowing `codegen.rustManifest`
and `codegen.rustPackage` to the app crate. If the generator binary is
ambiguous, add `codegen.rustBinary`. A staticlib target error is resolved by
adding `staticlib` to `[lib] crate-type`.
