English | [한국어](./compatibility-matrix.ko.md)

# Feature × Adapter Compatibility Matrix

A matrix of the invoke features (signal/cancellation, batch, events) each adapter supports. See at a glance which combinations are silently dropped — and which are not.

## Matrix

| Feature                                   | Node (`createNodeEngine`)                                                                          | Bun (`createBunEngine`)                                      | Tauri (`createTauriEngine`)               | RN (`createReactNativeEngine`)                           | RN (`createRkyvV2Engine`)                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.signal` (pre-abort)              | ✅ immediate `cancelled`                                                                           | ✅ immediate `cancelled`                                     | ✅ immediate `cancelled`                  | ✅ immediate `cancelled`                                 | ✅ immediate `cancelled`                                                                                                                    |
| `options.signal` (in-flight cancellation) | ⚠️ shallow cancellation (a non-aborted signal runs normally; an abort mid-run discards the result) | ⚠️ shallow cancellation (same)                               | ⚠️ shallow cancellation (same)            | ⚠️ shallow cancellation (rejects the JS promise only)    | ⚠️ conditional propagation — reaches the Rust checkpoint only when the JS codec + `invokeAsync`/`invokeCancel` are confirmed                |
| `invokeBatch`                             | ✅ per-entry Promise fallback                                                                      | ✅ per-entry Promise fallback                                | ✅ per-entry Promise fallback             | ✅ per-entry Promise fallback                            | ✅ single crossing for static commands (`invokeTypedBatch[ById]`); per-entry routing when signal entries are present                        |
| Per-entry batch cancellation              | ✅ shallow cancellation of each `invoke`                                                           | ✅ same                                                      | ✅ same                                   | ✅ same                                                  | ⚠️ single-crossing batches do not support cancellation — routed automatically to the per-entry `invoke` path when a signal entry is present |
| `options.timeoutMs`                       | ✅ direct/global `invoke` race — `transport.timeout` (retryable)                                   | ✅ same                                                      | ✅ same                                   | ⚠️ synchronous native calls cannot be preempted mid-call | ✅ same (a global batch races the whole batch at the per-entry minimum)                                                                     |
| Events (`subscribeEvent`/`onEvent`)       | ✅ `subscribeEvent(transport, name, cb)` — `__drainEvents` polling                                 | ✅ `createBunEventBridge` — FFI push sink (polling fallback) | ✅ `subscribeEvent`/`subscribeTauriEvent` | ❌ JSON adapter                                          | ✅ `subscribeEvent`/`drainEvents` (CallInvoker auto drain)                                                                                  |
| Channels (`createChannel`)                | ❌ no transport channel source                                                                     | ❌ no transport channel source                               | ❌ no Tauri channel adapter               | ✅ JSI handle + `close()`                                | ✅ JSI native channel handle                                                                                                                |
| rkyv V2 binary (`createRkyvV2Engine`)     | ✅ (requires the napi/FFI native)                                                                  | ✅ (requires the FFI native)                                 | ✅ (`rustra_dispatch` binary path)        | —                                                        | ✅ JSI                                                                                                                                      |

## Signal semantics in detail

- **Pre-abort**: every adapter rejects immediately with `cancelled` — the request has not been sent yet.
- **In-flight cancellation**:
  - JSON transports (Node/Bun/Tauri and the RN JSON adapter) forward the round trip to the native side and cannot interrupt execution itself. Under the **shallow cancellation policy** they reject only the JS Promise with `cancelled` and ignore late results.
  - The RN rkyv V2 engine **propagates** to the Rust checkpoint when `invokeAsync`+`invokeCancel` exist and the commandId/codec path is confirmed. Static typed paths, legacy natives, and paths where the commandId cannot be confirmed fall back to shallow cancellation.
- **Timeout** (`options.timeoutMs`): common to all engines — the global `invoke` starts a settle race. On expiry it rejects with `transport.timeout` (retryable) and late responses are ignored. A batch (`invokeBatch`) races the entire batch with the **minimum** of the per-entry `timeoutMs` values.
- **Event subscription call shape**: generated event contracts use `(name, callback)`. RN accepts both this canonical form and the legacy `(native, name, callback)`; Tauri uses an optional `listen` injection or the global Tauri event API.
- **Event delivery path**: Tauri is a Rust `app.emit` **push**, RN is a JSI sink **push**, Bun is an FFI C callback sink **push** (`rustra_ffi_event_sink_register` — hosts that emit from background threads use the `poll` option's polling fallback), and Node is `__drainEvents` special-command **polling** (`RUSTRA_NODE_EVENT_POLL_MS`, default 100ms). When a Rust `set_event_sink` is installed the bus drains (the contract that prevents dual push+polling reception), so push and polling are not mixed.

## invokeBatch semantics

- Every adapter exposes a Promise-based `invokeBatch`. Node/Bun/Tauri/RN JSON run each entry through the common `invoke` and preserve order. The rkyv V2 engine bundles supported static commands into a single native crossing.
- Static commands without a signal → single JSI crossing (`invokeTypedBatchById` preferred).
- Mixed dynamic commands or a signal present → routed to per-entry `invoke` (each entry's cancellation policy applies).

## Notes

- Per-adapter stable scope and gates: [compatibility-contract.md](compatibility-contract.md)
- Cancellation propagation design: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`

## Spike: wasm32 engine in wasm3 (React Native) — VERDICT: PASS (spike)

Task A0 spike (`examples/rn-wasm-spike/`, 2026-08-31) proved a rustra engine
compiled to `wasm32-unknown-unknown` runs inside a wasm3 interpreter embedded
in a React Native app, as a THIRD execution mode alongside the JSON adapter and
rkyv V2 JSI:

| Aspect                         | Result                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms proven               | ✅ iOS simulator (iPhone 17) AND Android emulator (API 36 arm64) — real `.wasm`, real wasm3 v0.9.1, real RN 0.81.5 app                                                                                                                                                                   |
| wasm vs native byte-equality   | ✅ postcard responses byte-identical to the native staticlib engine on both commands, both platforms (`double(21)` → `01010c7b2276616c7565223a34327d00`)                                                                                                                                 |
| In-app engine swap, no restart | ✅ `engine_v1.wasm` → `engine_v2.wasm` re-instantiated mid-process (iOS via Documents push, Android via `adb push` + filesDir — like an OTA drop): engineVersion 2→3, **contract hash unchanged** (`e79b7f01…`), `double(21)` behavior 42→63 in-wasm while the native baseline stayed 42 |
| Contract stability across swap | ✅ hash identical across engines and across native/wasm — the frozen-contract invariant holds on device                                                                                                                                                                                  |
| Performance red flags          | ✅ none — instantiate 1–4 ms; per-call wasm 0.1–20 ms vs native 0.03–0.05 ms (gates: >100x native per-call, >10 s instantiate)                                                                                                                                                           |
| Core patches required          | ✅ NONE — sync FFI entries only; the async worker pool is never initialized on wasm (see `examples/rn-wasm-spike/NOTES.md`)                                                                                                                                                              |

Scope caveats: sync commands only (the async worker pool would panic on
wasm32 without atomics), staging protocol uses spike-local
`spike_alloc`/`spike_unstage` exports, and the evidence was captured on
emulators/simulator — not yet on physical devices. Full hex transcripts:
`examples/rn-wasm-spike/evidence/{ios,android}.md`.

## Hot-swap follow-up (Task A1): process-internal reset selected — dlopen swap NOT adopted

Task A1 (dev-loop reload orchestration, 2026-08-31) adopted the
**process-internal engine reset** as the primary mechanism, per the A0 verdict.
True dlopen swap was evaluated and rejected:

- **Node**: engines are spawned child processes, so reload = dispose the child
  → re-spawn (the new binary image is read at spawn time). Two flavors:
  loop-based hosts settle gracefully with a
  `NodeLoopTransport.drain(timeoutMs = 5s)` → dispose → re-bootstrap, while
  `NodeBootstrap.reload()` (one-shot process transport, no drain) does a
  shallow cancel — in-flight invocations reject during dispose — then
  re-bootstraps and re-readies. A rebuilt `cargo` artifact is picked up by
  reload alone.
- **Bun**: EMPIRICAL FINDING (macOS arm64, Bun 1.4.0; probed with a minimal
  versioned dylib in both directions plus the real calculator cdylib):
  `bun:ffi` dlopen caches the library image per process. Re-dlopen of a REPLACED
  file at the same path returns the OLD bytes while any unclosed handle to that
  image has ever been opened; only close-then-reopen picks up new bytes. A real
  engine cannot guarantee every handle is closed (the codecs map and generated
  closures may retain one), so `BunBootstrap.reload()` re-initializes engine
  state and WARNS loudly that a rebuilt cdylib applies on the next process
  start. This is the honest "new binary applies on next process start" option
  from the plan.
- **Tauri**: docs-only. The adapter is a stateless wrapper over Tauri IPC
  (`rustra_dispatch`) — there is no engine state to re-initialize, and binary
  replacement is the Tauri host process's responsibility (app restart, or the
  A2 `rustra_ffi_hot_reload` injection, landed this cycle).
- **Dev loop**: `rustra dev` exposes an `onReload` hook on its watch handle,
  fired after a successful regeneration that touched the Rust side (legacy
  layout: `plan.rustBin` ran; config mode cannot distinguish causes and fires
  on every successful regeneration — the conservative default). Hook errors are
  logged (`[dev] reload failed: …`) and never kill the watch loop; the host
  callback owns draining its own in-flight invocations.

## wasm dev target (Task A3): build orchestration, doctor notice, release guard

With `dev.target = "wasm"`, `rustra dev` (config mode) now orchestrates the
engine's wasm32 build after every codegen run: the A0 spike's exact command and
artifact layout (`cargo build --manifest-path <Cargo.toml> --target
wasm32-unknown-unknown --release` →
`<target>/wasm32-unknown-unknown/release/<lib_target_name>.wasm` — cargo derives
the cdylib artifact name from the **lib target** name (`-`→`_`), not the package
name; the same `[lib] name` source as the RN `lib${rustLibrary}.a` convention;
cdylib target, release profile = the A0-verified opt-level
"s"/panic=abort configuration). The engine crate is resolved with the RN
adapter's priority (`reactNative.rustManifest`/`rustPackage` →
`codegen.*`), where the codegen-manifest fallback replaces the adapter's upward
search step — already validated to exist, so a bad resolution fails loudly at
the `cargo metadata` stage. The built artifact path is announced
(`[dev:wasm] engine artifact: <path>`). Pushing that file to a device is a host
integration point (adb push / Documents drop — the A0 app flows), deliberately
not automated by the CLI. A failed wasm build propagates before the parity gate
and reload emission — the host never receives a reload signal for an engine
that does not exist. The A2 parity gate composes unchanged.

Two doctor checks accompany the target: a non-failing warning that the wasm dev
target is experimental — **cooperative cancellation only; verify natively before
release** (concurrency bugs — races/cancellation/backpressure — cannot reproduce
on single-threaded cooperative wasm32), and a required check that the
`wasm32-unknown-unknown` rustup target is installed. The release-coherence
script now fails if any published package's `files` would ship the wasm backend
(`wasm3` sources, `wasm32*` artifacts, `wasm-backend` directories, `*.wasm`
engines) — the backend is dev-only until it graduates through the versioning
policy.
