English | [한국어](./README.ko.md)

# hot-core Probe

A standalone verification binary that exercises the experimental
[`hot-core`](../../docs/plans/2026-09-09-native-hot-core-design.md) surface end
to end inside **any process that can run a Rust binary** — the macOS host, an
iOS simulator (`simctl spawn`), or an Android emulator (`adb shell`). The host
app's hot mode (`examples/tauri-calculator`) performs the same sequence; this
probe makes the sequence observable and exit-code assertable on targets where
launching a full host app is inconvenient.

## What it verifies

1. `DylibCore::open` — dlopen → `rustra_mobile_init` → symbol binding
2. JSON dispatch round trip (`addNumbers`) + unknown-command error splitting
3. Contract hash retrieval (SHA-256 hex, 64 chars)
4. Versioned swap copy (`prepare_swap_copy`) → open the copy → same hash
5. `HotCoreHandle::swap` — new calls reach the new core
6. Old-core survival — no `dlclose`, swapped-out cores stay callable
7. `--watch N` — the sha256 polling watch thread swaps when an external
   publisher replaces the artifact bytes (reported as `PROBE SWAP` on stdout)

## Usage

```bash
# Build the probe and the swap-unit cdylib for the target
cargo build --release -p rustra-hot-core-probe -p rustra-calculator-example
# iOS simulator
cargo build --release --target aarch64-apple-ios-sim \
  -p rustra-hot-core-probe -p rustra-calculator-example
# Android (arm64 emulator), via cargo-ndk
cargo ndk -t arm64-v8a build --release \
  -p rustra-hot-core-probe -p rustra-calculator-example

# macOS host
./target/release/rustra-hot-core-probe \
  ./target/release/librustra_calculator_example.dylib

# iOS simulator (booted device UUID, absolute paths)
xcrun simctl spawn <UDID> \
  target/aarch64-apple-ios-sim/release/rustra-hot-core-probe \
  target/aarch64-apple-ios-sim/release/librustra_calculator_example.dylib

# Android emulator (shell domain)
adb push target/aarch64-linux-android/release/rustra-hot-core-probe /data/local/tmp/
adb push target/aarch64-linux-android/release/librustra_calculator_example.so /data/local/tmp/
adb shell chmod 755 /data/local/tmp/rustra-hot-core-probe
adb shell /data/local/tmp/rustra-hot-core-probe /data/local/tmp/librustra_calculator_example.so
```

Exit code `0` + `PROBE PASS` means every step held. Any failing step prints
`PROBE FAIL step=<name>` and exits `1`.

### Watch mode

```bash
rustra-hot-core-probe <artifact> --watch 10
```

The probe opens the artifact, spawns the watch thread, and polls for 10
seconds while an external publisher replaces the artifact bytes. Publisher
contract: **replace by atomic rename, never write in place** — overwriting a
dylib file that a process has mapped is corruption (`SIGKILL` on
macOS/iOS, `SIGSEGV` on Android). This mirrors the CLI contract: `rustra dev`
publishes the gated `-hot-live` artifact through temp-file + rename, which
preserves the old inode for live mappings.

Success output is a `PROBE SWAP <old> -> <new>` line (the swap happened) and
`PROBE WATCH DONE <hash>` (the swapped-in core keeps serving).

## Verified matrix (2026-09-09)

| Target | dlopen + dispatch | version copy + swap | watch swap | note |
| --- | --- | --- | --- | --- |
| macOS arm64 (host) | ✅ | ✅ | ✅ | ad-hoc re-sign path |
| iOS simulator (aarch64-apple-ios-sim, iOS 26.2) | ✅ | ✅ | ✅ | no in-app codesign needed |
| Android emulator (aarch64-linux-android, API 36.1) | ✅ | ✅ | ✅ | shell domain |
| Android app domain (`untrusted_app`, targetSdk 35) | ✅ | ✅ (concurrent duplicate-SONAME load) | — | `System.load` from `filesDir` |

The Android app-domain row means the Phase 3 prerequisite holds: an app can
dlopen its own copied-in `app_data_file` and load a second version copy
alongside the first — bionic keys loads by path, so the shared SONAME of the
versioned copies does not collide.

iOS real devices are out of scope by design (library validation always on —
see the design doc).

## Key files

| File       | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `src/main.rs` | the probe: sync checks 1–6, plus `run_watch` for watch mode      |
