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
   publisher replaces the artifact bytes (reported as `PROBE SWAP` on stdout),
   then observes a fixed command list against the swapped-in core
   (`PROBE OBS ...` on stdout)

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

Unlike sync mode, watch mode skips the value asserts (`addNumbers(2,3) == 5`
etc.): the starting artifact is the swap unit of a scenario, and its
`addNumbers` semantics legitimately vary per feature set (see
`examples/hot-core-variant` — the cargo features _are_ the scenarios). Only
the initial/final contract hash (64-char SHA-256 hex) is asserted.

Output contract:

```
PROBE CONTRACT <hash>            # baseline hash of the opened artifact
PROBE SWAP <old> -> <new>        # one line per applied swap (watch thread)
PROBE SWAP FAILED <error>        # a rejected/failed swap attempt
PROBE WATCH DONE <hash>          # the swapped-in core keeps serving
PROBE OBS <command> ok <json>    # observation phase, success wire
PROBE OBS <command> err <code>   # observation phase, error wire (code only)
```

The observation phase invokes the fixed list `addNumbers`, `multiplyNumbers`,
`addNumbersV2` (each with `{"a":2,"b":3}`) against the swapped-in core and
reports the wire verbatim — no hard asserts, since per scenario either
outcome can be the correct one (after a rename swap, `addNumbers` returning
`command.not_found` _is_ the pass condition).

#### Swap scenarios (`examples/hot-core-variant`)

```bash
# Build each scenario's swap unit, stage it, then publish with rename:
cargo build --release -p rustra-hot-core-variant                    # base
cargo build --release -p rustra-hot-core-variant --features behavior
cp target/release/librustra_hot_core_variant.dylib publish.tmp.dylib
mv -f publish.tmp.dylib /path/to/live.dylib
```

Measured on macOS arm64 (2026-09-09), each scenario = one feature flip plus
one atomic rename while the probe watches:

| Scenario             | feature flip                    | contract hash | observation (`PROBE OBS`)                                                      |
| -------------------- | ------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| 1. logic-only change | base → `behavior`               | unchanged     | `addNumbers ok {"value":105}` (was `5`) — the data changed under a stable hash |
| 2. command added     | → `add-cmd behavior`            | changed       | `multiplyNumbers ok {"value":6}`                                               |
| 3. command renamed   | → `rename-cmd add-cmd behavior` | changed       | `addNumbers err command.not_found` + `addNumbersV2 ok {"value":105}`           |
| 4. signature change  | → `sig-change behavior`         | changed       | `addNumbers err command.invalid_args` (the `{a,b}` call misses `c`)            |

## Verified matrix (2026-09-09)

| Target                                             | dlopen + dispatch | version copy + swap                   | watch swap | note                          |
| -------------------------------------------------- | ----------------- | ------------------------------------- | ---------- | ----------------------------- |
| macOS arm64 (host)                                 | ✅                | ✅                                    | ✅         | ad-hoc re-sign path           |
| iOS simulator (aarch64-apple-ios-sim, iOS 26.2)    | ✅                | ✅                                    | ✅         | no in-app codesign needed     |
| Android emulator (aarch64-linux-android, API 36.1) | ✅                | ✅                                    | ✅         | shell domain                  |
| Android app domain (`untrusted_app`, targetSdk 35) | ✅                | ✅ (concurrent duplicate-SONAME load) | —          | `System.load` from `filesDir` |

The Android app-domain row means the Phase 3 prerequisite holds: an app can
dlopen its own copied-in `app_data_file` and load a second version copy
alongside the first — bionic keys loads by path, so the shared SONAME of the
versioned copies does not collide.

iOS real devices are out of scope by design (library validation always on —
see the design doc).

## Key files

| File          | Description                                                             |
| ------------- | ----------------------------------------------------------------------- |
| `src/main.rs` | the probe: sync checks 1–7, plus `run_watch` (swap + observation phase) |
