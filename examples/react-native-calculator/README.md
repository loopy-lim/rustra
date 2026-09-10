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

`rustra.json` only specifies the location of the monorepo app crate. Cargo
package/library names, TypeScript bootstrap,
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

## Android hot core smoke (dev)

The native hot core swap keeps the JSI surface static and re-points the dispatch
table inside the C++ core, so a behavior-only change (schema/contract hash
unchanged) reaches the running app without a JS reload. The smoke proves it with
`addNumbers(2,3)`: the static core answers `5`, the pushed behavior variant
(`a+b+100`) answers `105` in the same log stream.

Delivery contract — tmp + rename, never in-place:

- The app watches `<filesDir>/rustra/hot` for `*-hot-live.so` (Kotlin
  `nativeConfigureHotCore` is called right after `nativeInstall`; a missing file
  simply keeps the static core).
- Overwriting the file that a process has already `dlopen`-ed in place is a
  SIGSEGV on Android (modified file pages are re-loaded). Every delivery is
  therefore written to `live-tmp.so` and swapped in with `run-as mv`, which is
  a same-directory `rename(2)` — atomic, old inode preserved.
- `/data/local/tmp` cannot be used as a staging area: the app domain
  (`untrusted_app`) may not read `shell_data_file`, so `run-as cp` from there is
  an SELinux denial. The push script therefore streams the bytes through stdin
  into `run-as <pkg> dd of=<absolute path>` — no shell metacharacters, since
  some adbd builds split quoted `sh -c` commands and would apply the redirect in
  the wrong shell (verified on an API 36 emulator). The transferred byte count
  is re-read and compared before the atomic rename.

One-time prerequisites: a running emulator (`adb devices`, default
`emulator-5554`, override with `--serial` or `ADB_SERIAL`), NDK/cargo-ndk for
the cdylib, and a debuggable app build (`run-as` refuses release builds).

```bash
# terminal 1 — serve the hot-core app branch
bun run demo:hot-core

# terminal 2 — full smoke: cargo ndk cdylibs → gradle assembleDebug + install
# → boot → [RustraHotCore] READY value=5 → push → observe addNumbers 5→105
bun run test:hot-core:android

# or deliver a prebuilt cdylib manually and watch the log
bun run push:hot-core:android -- <path-to>/librustra_hot_core_variant.so
adb logcat -v time | grep '[RustraHotCore]'
```

Useful flags: `--skip-cargo` / `--skip-gradle` reuse existing artifacts and the
installed app; `--package` overrides the auto-detected application id
(`app.json` → `android/app/build.gradle`); the push script verifies the
transferred byte count and fails loudly on a truncated pipe.

## iOS simulator hot core smoke (dev)

The same swap contract runs on the iOS simulator, with iOS-specific delivery
mechanics. Physical devices are out of scope (the app sandbox is not reachable
from the host filesystem there).

Delivery contract — env-passed directory, tmp + rename, never in-place:

- The iOS adapter reads the `RUSTRA_HOT_CORE_DIR` environment variable (a
  directory) when the JSI module installs and polls that directory for
  `*-hot-live.*`. The smoke passes the path with the `SIMCTL_CHILD_` prefix
  (`SIMCTL_CHILD_RUSTRA_HOT_CORE_DIR=<dir> xcrun simctl launch …`), which
  `simctl` propagates into the app process (verified). An empty directory boots
  the static core — stale live files are removed before launch so the
  baseline (`READY value=5`) is observed from the static core.
- The hot directory lives in the app's data container:
  `<data container>/Documents/rustra/hot`, resolved with
  `xcrun simctl get_app_container <udid> <bundle-id> data` at launch **and**
  push time — reinstalling the app can change the container path, and a
  mismatch between the env path and the push target would make the swap
  unobservable.
- Simulator containers sit on the host filesystem, so the push script can write
  directly. But overwriting a dylib the process has already `dlopen`-ed in
  place is a SIGKILL on iOS. Every delivery is therefore written to
  `live-tmp.dylib` and swapped in with a same-directory rename(2) — atomic, old
  inode preserved. The written byte count is verified before the rename.

One-time prerequisites: a booted simulator (the smoke boots the default iPhone
17 if none is running; override with `--udid` or `RUSTRA_SIM_UDID`), and Metro
serving the hot-core branch.

```bash
# terminal 1 — serve the hot-core app branch
bun run demo:hot-core

# terminal 2 — full smoke: cargo ios-sim cdylibs → xcodebuild + install →
# boot → [RustraHotCore] READY value=5 → push → observe addNumbers 5→105
bun run test:hot-core:ios

# or deliver a prebuilt cdylib manually and watch the log stream
bun run push:hot-core:ios -- <path-to>/librustra_hot_core_variant.dylib
xcrun simctl spawn booted log stream --style compact \
  --predicate 'eventMessage CONTAINS "[RustraHotCore]"'
```

Useful flags: `--skip-cargo` / `--skip-xcodebuild` reuse existing artifacts and
the installed app; `--ready-timeout-ms` / `--swap-timeout-ms` tune the
observation windows; `--bundle-id` overrides the auto-detected bundle id
(`app.json` → `expo.ios.bundleIdentifier`).

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
