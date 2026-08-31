# rn-wasm-spike — implementation notes (Task A0)

Spike question: can a rustra engine compiled to `wasm32-unknown-unknown` run
inside a wasm3 interpreter embedded in a React Native app on iOS/Android, with
byte-identical postcard responses vs the native staticlib engine, and with the
engine swappable at runtime without an app restart?

Everything in this directory is self-contained. The repo root workspace, the
`rustra` crate, and all packages are UNTOUCHED — see "Core patches required"
at the bottom for what production WOULD need (none were needed for the spike).

## Layout

- `backend/` — standalone-workspace crate (path-dep on `../../crates/rustra`).
  - Same source builds three ways: rlib (host tests), staticlib (native
    baseline), cdylib → `.wasm` (wasm3 path).
  - Commands: `double(n)` and `addNumbers(a, b)`.
  - `factor3` cargo feature bakes `SPIKE_FACTOR=3` — the v2 swap-PoC engine.
    Schema/ids/contract hash are identical; only handler logic differs.
- `native/wasm3/` — vendored wasm3 v0.9.1 core interpreter sources (C).
  From https://github.com/wasm3/wasm3 (MIT). Only `source/*` core files; no
  platforms/. Not a git submodule (repo convention).
- `scripts/wasm3-smoke-main.c` — desktop harness that runs the REAL wasm3
  against the REAL `.wasm` and does a full postcard round-trip through linear
  memory staging. This is the protocol the RN native modules mirror.
- `scripts/build-backend.sh` / `scripts/build-v2.sh` — artifact builds.
- `artifacts/` — gitignored build outputs (`engine_v1.wasm`,
  `engine_v2.wasm`, `librustra_wasm_spike_backend.a`). Regenerate before
  building the RN apps: `scripts/build-backend.sh && scripts/build-v2.sh`.

## Wire protocol used by the spike host (wasm3 or staticlib caller)

Request (postcard, core `FfiPostcardEnvelope`):
`(command: String, args_json: String)` — postcard str = varint len + bytes.
Example `double {"n":21}` → `06 646f75626c65 07 7b226e223a32317d`

Response (postcard, core `FfiPostcardResponse`):
`(ok: bool, result_json: Option<String>, error: Option<String>)`
Example ok `{"value":42}` → `01 01 0c 7b2276616c7565223a34327d 00`
(`ok=1`, `Some=1`, len `0x0c`, 12 JSON bytes, `None=0`).

NOTE: the returned buffer from `rustra_ffi_invoke_postcard` is a pointer
PAST core's hidden 8-byte header (`TSUR` magic + u32 LE len sits BEFORE the
returned pointer; `out_len` is the payload length). Free with
`rustra_ffi_free`/`spike_free` using the full returned pointer — do NOT
expect a visible header in the payload bytes.

wasm call protocol (see `scripts/wasm3-smoke-main.c`):

1. `off = spike_alloc(len)` (module-side malloc; host cannot malloc in wasm)
2. host writes request bytes at `memory[off..]`
3. `len_off = spike_alloc(4)`; host zeroes 4 bytes there
4. `resp_off = spike_invoke(off, len, len_off)`
5. host re-syncs its `m3_GetMemory` view (memory can grow!), reads
   `resp_len = u32le(memory[len_off..])`, copies `memory[resp_off..+len]`
6. `spike_free(resp_off, resp_len)`, `spike_unstage(off, len)`,
   `spike_unstage(len_off, 4)`

## Why the async worker pool is not a wasm hazard here

`crates/rustra/src/ffi_pool.rs` spawns 2 `std::thread` workers, but the pool
is created lazily (OnceLock) ONLY from the async FFI entries
(`rustra_ffi_invoke_async`, `rustra_ffi_invoke_json_async`,
`rustra_ffi_invoke_rkyv_v2_async*`). The spike drives ONLY sync entries
(`rustra_ffi_invoke_postcard`, `rustra_ffi_contract_hash`), so the pool is
never initialized on the wasm path. Runtime corroboration: on
wasm32-unknown-unknown without atomics, `std::thread::spawn` compiles but
PANICS at runtime — a successful wasm3 invoke is itself proof that no spawn
occurred on that path. The spike hosts never call `*_async` on wasm.

## Core patches required

NONE for this spike. `cargo build --target wasm32-unknown-unknown --release`
of a rustra-depending engine succeeds out of the box (rustra 0.5.0 @ 116eae3d,
edition 2024, rust 1.88+). 848 KB .wasm (release, opt-level "s", panic=abort)
exporting `memory` + all core `rustra_ffi_*` sync symbols.

For PRODUCTION (design-review items, not done here):

1. `#[cfg]`-gate `ffi_pool.rs`/`ffi_workers.rs` for
   `target_family = "wasm"` so async entries either return
   `invoke.unsupported_on_wasm` error frames or run inline, instead of
   compiling code that would panic at spawn time if ever called.
2. Consider a `postcard`-native args path (today `args_json` embeds a JSON
   string inside postcard — fine, but it means serde_json must link on wasm;
   it does, at ~small cost).
3. `spike_alloc`/`spike_unstage` are spike-local staging helpers; a production
   host ABI would standardize an alloc/export pair (or caller-buffer
   `*_into` entries, which already exist for JSON/rkyv but not postcard).

## Verified on devices (2026-08-31) — verdict: PASS on BOTH

Full hex-level transcripts: `evidence/ios.md`, `evidence/android.md`.

- iOS simulator (iPhone 17, RN 0.81.5/Hermes, wasm3 + staticlib linked in-pod):
  v1 instantiate 1.0 ms, ver=2, hash `e79b7f01…`; `double(21)` and
  `addNumbers(40,2)` BYTE-IDENTICAL wasm vs native staticlib; mid-run swap
  (Documents/engine_v2.wasm pushed via simctl, no restart) → ver=3, hash
  UNCHANGED, `double(21)` in-wasm 42→63 while native baseline stayed 42,
  `addNumbers` still identical.
- Android emulator (Medium_Phone_API_36.1, RN 0.81.5 bridgeless, JNI + CMake,
  per-ABI staticlibs): v1 instantiate 2.0 ms, same hash; both commands
  BYTE-IDENTICAL; swap twice-proven (button tap pid 6245, and fully automatic
  poller swap pid 6541 after `adb push` + `run-as cp` of engine_v2.wasm) →
  ver=3, hash UNCHANGED, `double(21)` 42→63 in-wasm, `addNumbers` identical.
- Spike gotchas recorded for posterity:
  - On API 36 the JNI lib is mapped straight out of base.apk
    (extractNativeLibs=false); `adb install -r` can silently keep the old APK —
    the stale .so (per-entry-point engines) produced "find spike_alloc:
    function lookup failed". Force `uninstall` + `install` when JNI signatures
    change.
  - RN android cannot serialize a JNI HashMap across the bridge — the Kotlin
    side converts to a WritableMap.
  - CocoaPods rejects source_files outside the pod root, so the pod's
    prepare_command stages native/wasm3 + the staticlib INTO the pod
    (ios/build-rust-ios.sh).
- No perf red flags: worst observed per-call wasm time 20 ms (iOS first call),
  steady state 0.1–9 ms vs native 0.03–0.05 ms; instantiate ≤ 4 ms everywhere
  (gates: >100x native per-call, >10 s instantiate).

## Verified so far (desktop, before device runs)

- `cargo test` (host rlib): 4/4 pass — postcard round-trip for both commands,
  contract-hash stability, engine-version probe.
- wasm3 (real interpreter, real .wasm): parse+load 0.4–0.6 ms,
  `spike_engine_version=2`, contract hash
  `e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2`
  (identical to native), `double(21)` →
  `01010c7b2276616c7565223a34327d00` — byte-identical to the native rlib
  response, 0.02 ms avg per full staging+invoke+free round-trip (macOS host).
- v2 engine (`--features factor3`): version=3,
  `double(21)` → `01010c7b2276616c7565223a36337d00` (`{"value":63}`),
  contract hash UNCHANGED — the swap-PoC invariant holds on desktop.

