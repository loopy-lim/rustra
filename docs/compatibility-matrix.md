English | [한국어](./compatibility-matrix.ko.md)

# Feature × Adapter Compatibility Matrix

A matrix of the invoke features (signal/cancellation, batch, events) each adapter supports. See at a glance which combinations are silently dropped — and which are not.

## Matrix

| Feature                                   | Node (`createNodeEngine`)                                                                                                 | Bun (`createBunEngine`)                                      | Tauri (`createTauriEngine`)                                                            | RN (`createReactNativeEngine`)                           | RN (`createRkyvV2Engine`)                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.signal` (pre-abort)              | ✅ immediate `cancelled`                                                                                                  | ✅ immediate `cancelled`                                     | ✅ immediate `cancelled`                                                               | ✅ immediate `cancelled`                                 | ✅ immediate `cancelled`                                                                                                                    |
| `options.signal` (in-flight cancellation) | ⚠️ shallow cancellation (a non-aborted signal runs normally; an abort mid-run discards the result)                        | ⚠️ shallow cancellation (same)                               | ⚠️ shallow cancellation (same)                                                         | ⚠️ shallow cancellation (rejects the JS promise only)    | ⚠️ conditional propagation — reaches the Rust checkpoint only when the JS codec + `invokeAsync`/`invokeCancel` are confirmed                |
| `invokeBatch`                             | ✅ per-entry Promise fallback                                                                                             | ✅ per-entry Promise fallback                                | ✅ per-entry Promise fallback                                                          | ✅ per-entry Promise fallback                            | ✅ single crossing for static commands (`invokeTypedBatch[ById]`); per-entry routing when signal entries are present                        |
| Per-entry batch cancellation              | ✅ shallow cancellation of each `invoke`                                                                                  | ✅ same                                                      | ✅ same                                                                                | ✅ same                                                  | ⚠️ single-crossing batches do not support cancellation — routed automatically to the per-entry `invoke` path when a signal entry is present |
| `options.timeoutMs`                       | ✅ direct/global `invoke` race — `transport.timeout` (retryable)                                                          | ✅ same                                                      | ✅ same                                                                                | ⚠️ synchronous native calls cannot be preempted mid-call | ✅ same (a global batch races the whole batch at the per-entry minimum)                                                                     |
| Events (`subscribeEvent`/`onEvent`)       | ✅ `subscribeEvent(transport, name, cb)` — 0xfffd push frames (polling fallback; loud-fail on event-incapable transports) | ✅ `createBunEventBridge` — FFI push sink (polling fallback) | ✅ `subscribeEvent`/`subscribeTauriEvent` — decoded-first payload contract (see below) | ❌ JSON adapter                                          | ✅ `subscribeEvent`/`drainEvents` (CallInvoker auto drain)                                                                                  |
| Channels (`createChannel`)                | ❌ no transport channel source                                                                                            | ❌ no transport channel source                               | ❌ no Tauri channel adapter                                                            | ✅ JSI handle + `close()`                                | ✅ JSI native channel handle                                                                                                                |
| rkyv V2 binary (`createRkyvV2Engine`)     | ✅ (requires the napi/FFI native)                                                                                         | ✅ (requires the FFI native)                                 | ✅ (`rustra_dispatch` binary path)                                                     | —                                                        | ✅ JSI                                                                                                                                      |

## Signal semantics in detail

- **Pre-abort**: every adapter rejects immediately with `cancelled` — the request has not been sent yet.
- **In-flight cancellation**:
  - JSON transports (Node/Bun/Tauri and the RN JSON adapter) forward the round trip to the native side and cannot interrupt execution itself. Under the **shallow cancellation policy** they reject only the JS Promise with `cancelled` and ignore late results.
  - The RN rkyv V2 engine **propagates** to the Rust checkpoint when `invokeAsync`+`invokeCancel` exist and the commandId/codec path is confirmed. Static typed paths, legacy natives, and paths where the commandId cannot be confirmed fall back to shallow cancellation.
- **Timeout** (`options.timeoutMs`): common to all engines — the global `invoke` starts a settle race. On expiry it rejects with `transport.timeout` (retryable) and late responses are ignored. A batch (`invokeBatch`) races the entire batch with the **minimum** of the per-entry `timeoutMs` values.
- **Shallow cancellation/timeout ≠ the command did not run**: the ⚠️ cells on shallow cancellation and `timeoutMs` mark the _JS observation_, not the Rust execution. On a shallow-cancel adapter (`signal` without `invokeCancel` propagation) or after a timeout, the Rust command keeps running or has already completed — its result is discarded, not its execution. `retryable: true` (`transport.timeout`, `cancelled`, `transport.error`) therefore means "the failure class may clear on a retry", never "re-running the command is safe". Retry non-idempotent commands only after a status re-query proves the earlier attempt did not land; see "Timeout, Cancellation, and Retry Semantics" in [rust-api-guide.md](rust-api-guide.md).
- **Event subscription call shape**: generated event contracts use `(name, callback)`. RN accepts both this canonical form and the legacy `(native, name, callback)`; Tauri uses an optional `listen` injection or the global Tauri event API.
- **Event delivery path**: Tauri is a Rust `app.emit` **push**, RN is a JSI sink **push**, Bun is an FFI C callback sink **push** (`rustra_ffi_event_sink_register` — hosts that emit from background threads use the `poll` option's polling fallback), and Node is dual-mode: `subscribeEvent` prefers `events:"push"` handshake **push** over stdout 0xfffd frames when the loop-stdio runtime accepted it, falls back to `__drainEvents` special-command **polling** (`RUSTRA_NODE_EVENT_POLL_MS`, default 100ms) otherwise (legacy runtimes, no-codecs transports), and throws `event.unavailable` on transports that can never deliver events. Unlike polling, push mode (Node stdout, Bun FFI) discards emits that happen before the first subscription — the sink bypasses the bus, so subscribe before emitting or use polling if pre-subscription emits matter. When a Rust `set_event_sink` is installed the bus drains (the contract that prevents dual push+polling reception), so push and polling are not mixed.
- **Tauri payload contract (decoded-first, string-only single parse)**: at the real WebView boundary tauri splices the `emit_str` JSON into the page as `payload: {…}`, so the JS listener already receives a decoded value — `subscribeEvent` passes any non-string payload through untouched (no re-parse, object identity preserved). Only `typeof payload === 'string'` gets exactly one `JSON.parse`; if the result is an object, array, or string it is delivered (an escaped-JSON string unwraps exactly once), and if the result is a primitive (`'123'`, `'true'`) the original string is kept — a string payload never silently changes type. Parse failure delivers the original string. There is no content-based sniffing: a string payload stays a string even when it looks like JSON. Legacy injected transports (`__TAURI__` fakes delivering serialized strings) are covered by the same rule, with no separate mode. One known divergence between the two delivery modes: primitive event payloads arrive as the primitive itself under the real WebView (`payload: 42`) but stay the original string (`'42'`) under a legacy-string transport — the production boundary is the real WebView.

## invokeBatch semantics

- Every adapter exposes a Promise-based `invokeBatch`. Node/Bun/Tauri/RN JSON run each entry through the common `invoke` and preserve order. The rkyv V2 engine bundles supported static commands into a single native crossing.
- Static commands without a signal → single JSI crossing (`invokeTypedBatchById` preferred).
- Mixed dynamic commands or a signal present → routed to per-entry `invoke` (each entry's cancellation policy applies).

## Notes

- **Verified combination**: npm `@rustra/*` 0.6.x ↔ Rust crate 0.5.x (workspace) is the combination currently exercised by CI. The crates.io version bump is part of the release procedure, not of adapter code — expect the documented pairing to move only in a release step.
- **Engine slot is single-engine** (bootstrap ownership): first `configureLazy`/`configure` registration wins; a second bootstrap registered while the first is still pending throws `registry.frozen` instead of silently winning by import order. Dispose/reload re-registration and post-consumption replacement stay allowed. Multi-engine is not supported.
- **Platforms not covered by runtime evidence**: the runtime claims in this
  matrix and in the README platform matrix are backed by the specific
  host/OS/build combinations listed there — macOS (Tauri WebView, Node, Bun),
  iOS simulator (RN), Android emulator and the `TB710FU` arm64 device (RN),
  plus the wasm spike's emulator/simulator runs. Everything outside those
  combinations — e.g. Tauri on Windows, Tauri Linux WebView user flows, other
  Android/iOS devices, RN Windows/macOS hosts — is **not** covered by a
  runtime claim here, and nothing in this matrix asserts it. Per-run manual
  checks: [verification checklist](verification-checklist.md).
- Per-adapter stable scope and gates: [compatibility-contract.md](compatibility-contract.md)
- Cancellation propagation design: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`

### Machine-readable surface: `engine.supports` (A02)

Each adapter's engine factory exposes a `supports` object (`@rustra/types`
`EngineSupports`) whose values are this matrix's cells transcribed 1:1 — no new
claims. Apps can branch before any side effect, e.g.
`engine.supports?.cancellation === 'cooperative'`. The mapping per column:

| `supports` field    | Node        | Bun JSON / Bun FFI rkyv V2 | Tauri       | RN JSON     | RN rkyv V2        |
| ------------------- | ----------- | -------------------------- | ----------- | ----------- | ----------------- |
| `cancellation`      | `shallow`   | `shallow` / `shallow`      | `shallow`   | `shallow`   | `cooperative`     |
| `batch`             | `per-entry` | `per-entry` / `per-entry`  | `per-entry` | `per-entry` | `single-crossing` |
| `events`            | `push`      | `push` / `push`            | `push`      | `none`      | `push`            |
| `channels`          | `false`     | `false` / `false`          | `false`     | `true`      | `true`            |
| `timeoutPreemption` | `true`      | `true` / `true`            | `true`      | `false`     | `true`            |

Nuances that do not fit one enum value stay in the matrix prose, not the enum:
RN rkyv V2 `cancellation: 'cooperative'` means the matrix's "conditional
propagation" cell (reaches the Rust checkpoint only when
`invokeAsync`+`invokeCancel` are exposed and the commandId/codec path is
confirmed; static typed paths and legacy natives fall back to shallow). The
Bun FFI rkyv V2 engine shares the same `createRkyvV2Engine` core, but its FFI
native binds only `invokeRkyvV2`/`getSchema`/`getContractHash`/
`getSchemaGeneration` — the `invokeAsync`/`invokeCancel` and
`invokeTypedBatch` symbols are not bound, so the conditional-propagation and
single-crossing conditions are unreachable and the engine is observed as
`shallow`/`per-entry`. The RN async engine (`createAsyncEngine`) runs
`invokeBatch` as per-entry `Promise.all` over the async `invoke`, so it
reports `batch: 'per-entry'` even though it inherits the sync engine's
`cancellation: 'cooperative'` (real when `invokeCancel` is exposed). The
`'push'` event value includes each engine's polling fallback — the actual
delivery path is determined by the per-adapter subscription surface. Tauri
`batch: 'per-entry'` follows the cell family even though track E2 added a
single-IPC wire batch (`rustra_dispatch_batch`) as an optimization.

### Bootstrap lifecycle state (A05)

The bootstrap objects (`createNodeBootstrap`/`createBunBootstrap`/
`createTauriBootstrap`/`createRustraBootstrap`) expose a local
`state: 'initializing' | 'ready' | 'disposed'` (shared as `BootstrapState` in
`@rustra/types`; all adapters reject post-dispose `ready()` with the same
`disposedBootstrapError` family). `dispose()` is idempotent (a second call is a
no-op), and `ready()` after `dispose()` rejects loudly instead of silently
re-resolving. `NodeBootstrap.reload()` drains the bootstrap's own transport
when it exposes `drain(timeoutMs)` (duck-typed; default 5 s guard — reload
proceeds after the timeout; a drain **rejection** aborts the reload without
disposing), and proceeds immediately otherwise (the one-shot stdio transport
has no drain; loop-transport hosts are not wired through `NodeBootstrap`).
State is re-checked at every await boundary inside `reload()`: a `dispose()`
during the drain or re-initialization aborts the reload instead of resurrecting
the bootstrap, and a failed re-initialization restores `initializing` (the
original error propagates) rather than bricking the bootstrap as `disposed`.
A `draining` state is deliberately not modeled: drain is transparent to the
three-state lifecycle. See the hot-swap section below for the reload contract
this builds on.

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
