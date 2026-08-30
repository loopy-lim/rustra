English | [한국어](./README.ko.md)

# React Native Calculator

A performance and runtime fixture that uses the Rustra generated JSI bridge in an
Expo development build, and connects the same Rust core to Nitro Modules and a
Swift FFI comparison path as well. The production usage path does not depend on
Expo APIs and uses the same autolinking modules as the bare RN fixture.

## Run

All app tasks run on Bun 1.4.

```bash
bun install
bun run codegen
bun run check
```

The real native build gates are as follows.

```bash
bun run verify:native:android
bun run verify:native:ios
```

To install the iOS Release app and extract the measurement receipt:

```bash
bun run ios -- --configuration Release
bun run bench:ios:receipt -- --output /tmp/rustra-rn-receipt.json
```

## App Code

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 42, b: 58 });
```

`rustra.json` only specifies the location of the monorepo app crate and a
benchmark-only legacy ABI flag. Cargo package/library names, TypeScript bootstrap,
Podspec, Gradle, CMake, and JNI are owned by the generator. The first command
performs JSI installation, contract verification, and fast engine setup exactly once,
so app code has no manual `install`/`configure`.

## Structure

```text
react-native-calculator/
  App.tsx
  BenchmarkApp.tsx
  generated/                         generated TypeScript entry/codecs
  modules/
    rustra-jsi/                      generated @rustra/generated-react-native
    rustra-calculator/               Swift FFI comparator
    nitro-bench/nitro-bench/         Nitro comparator
```

The directory name `rustra-jsi` is just the fixture's existing local location, not the
public package/module name. The actual collision-isolated names are as follows:

- package: `@rustra/generated-react-native`
- iOS/React Native module: `RustraBridge`
- Android namespace: `dev.rustra.bridge`
- shared library: `rustra_bridge`

The Rustra generated package uses only standard React Native autolinking. There are no
manual Rustra patches in the Expo module config, Podfile, `settings.gradle`, or
`MainApplication`. Expo Go cannot include JSI native code, so a development build is
required.

## doctor

```bash
bun run doctor
bun run doctor -- --json
```

doctor is read-only and independently checks the following layers.

- The lockfile of the current checkout combined with local `@rustra/*` packages
- Sync between the Rust schema, TypeScript entry, C++ codec, and build fingerprint
- iOS/Android autolinking and Pods
- iOS static archive freshness, architecture, and required FFI symbols
- Installed apps and the runtime fingerprint on the booted simulator

A Metro reload does not replace the static archive, Pods, or FFI symbols. If runtime
warnings persist, boot the simulator and reinstall the current native app.

To verify JSI reinstallation, Rust-owned byte buffer finalizers, and in-flight async
callbacks across 30 runtime reloads while the development Metro is running, run:

```bash
bun run demo:reload
bun run test:reload:ios -- --cycles 30
```

## Performance Comparison Contract

Nitro, Rustra, and FFI first verify identical inputs and result shapes, then measure
cyclically per call. The runner records the median of 3 runs, paired 95% CI,
p50/p95/p99, throughput, and diagnostics for the generated helper/native paths in the
receipt.

At the stored Release medians of 2026-08-24, the Rustra/Nitro ratios were add 1.0418x,
string 1.0281x, bytes64 0.9543x, pair 1.0535x, 64KiB 0.9338x, and exact 1MiB 1.0129x.
These are session observations, not guarantees for all devices. The latest results and
feature parity follow the [benchmark documentation](../../docs/benchmarks.md).

The Release receipt of the 0.4 final fingerprint
`eb14a45517032caa6adbfb1b366da70ef1adcb69633e09eac07fd831f37a90b1` also passed the
correctness and paired 95% CI gates.

The byte path validates the offset and length of `Uint8Array`/`ArrayBuffer` views and
passes the raw span to the caller-buffer FFI. The result copies the Rust-owned buffer
into a JS `ArrayBuffer` exactly once, and a free callback reclaims its lifetime.
Optional/compound byte shapes safely fall back to the general codec path.

## Verification Coverage

- `bun run test`: doctor/receipt/benchmark statistics/adapter regressions
- `bun run test:cpp-codec`: generated codec and byte lifetime C++ regressions
- `bun run verify:native:*`: real Android/iOS build and link
- `examples/react-native-bare-calculator`: RN autolinking regression without Expo

Build/link success does not substitute for long-running runs on physical devices.
Before a release, re-verify the generated commands, reload stress, and benchmark
receipt on the Release app of the current commit.
