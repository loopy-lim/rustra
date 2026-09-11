English | [한국어](./compatibility-matrix.ko.md)

# Feature × Adapter Compatibility Matrix

A matrix of the invoke features (signal/cancellation, batch, events) each adapter supports. See at a glance which combinations are silently dropped — and which are not.

## Matrix

Columns are keyed by the low-level engine factories. If you use the generated
host entry points (the default path), map them to columns like this:
`generated/node.ts` → the **Node** column (one-shot stdio JSON engine),
`generated/bun.ts` → the **Bun** column (its default is the FFI Frame engine —
see the Frame row and the `supports` table below), `generated/tauri.ts` → the
**Tauri** column, and `generated/react-native.ts` → the RN **`createFrameEngine`**
column. The RN JSON column applies only when you pass a custom transport to
`createReactNativeEngine` yourself. The UniFFI (Kotlin/Swift) surface is
covered in its [own section](#uniffi-bindings-track-b1-typed-kotlinswift-surface)
below — it is not an `EngineClient` column.

| Feature                                   | Node (`createNodeEngine`)                                                                                                                                                             | Bun (`createBunEngine`)                                                                                                      | Tauri (`createTauriEngine`)                                                                                                                  | RN (`createReactNativeEngine`)                                                            | RN (`createFrameEngine`)                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.signal` (pre-abort)              | ✅ immediate `cancelled`                                                                                                                                                              | ✅ immediate `cancelled`                                                                                                     | ✅ immediate `cancelled`                                                                                                                     | ✅ immediate `cancelled`                                                                  | ✅ immediate `cancelled`                                                                                                                    |
| `options.signal` (in-flight cancellation) | ⚠️ shallow cancellation (a non-aborted signal runs normally; an abort mid-run discards the result)                                                                                    | ⚠️ shallow cancellation (same)                                                                                               | ⚠️ shallow cancellation (same)                                                                                                               | ⚠️ shallow cancellation (rejects the JS promise only)                                     | ⚠️ conditional propagation — reaches the Rust checkpoint only when the JS codec + `invokeAsync`/`invokeCancel` are confirmed                |
| `invokeBatch`                             | ✅ per-entry Promise fallback                                                                                                                                                         | ✅ per-entry Promise fallback                                                                                                | ✅ per-entry Promise fallback                                                                                                                | ✅ per-entry Promise fallback                                                             | ✅ single crossing for static commands (`invokeTypedBatch[ById]`); per-entry routing when signal entries are present                        |
| Per-entry batch cancellation              | ✅ shallow cancellation of each `invoke`                                                                                                                                              | ✅ same                                                                                                                      | ✅ same                                                                                                                                      | ✅ same                                                                                   | ⚠️ single-crossing batches do not support cancellation — routed automatically to the per-entry `invoke` path when a signal entry is present |
| `options.timeoutMs`                       | ✅ direct/global `invoke` race — `transport.timeout` (retryable)                                                                                                                      | ✅ same                                                                                                                      | ✅ same                                                                                                                                      | ⚠️ synchronous native calls cannot be preempted mid-call                                  | ✅ same (a global batch races the whole batch at the per-entry minimum)                                                                     |
| Events (`subscribeEvent`/`onEvent`)       | ✅ `subscribeEvent(transport, name, cb)` — 0xfffd push frames (polling fallback; loud-fail on event-incapable transports)                                                             | ✅ `createBunEventBridge` — FFI push sink (polling fallback)                                                                 | ✅ `subscribeEvent`/`subscribeTauriEvent`                                                                                                    | ✅ JSI sink push; `pollMs` option adds a JS polling-drain loop for CallInvoker-less hosts | ✅ `subscribeEvent`/`drainEvents` (CallInvoker auto drain)                                                                                  |
| Channels (`createChannel`)                | ✅ `createNodeChannel(transport, cb)` — loop-stdio reservation frames 0xfffb/0xfffa/0xfffc (binary mode only; `channel.unavailable` loud-fail on NDJSON; background-thread send safe) | ✅ `createBunChannelBridge(options)(cb)` — FFI `rustra_ffi_channel_*` (JS-thread send only — `threadsafe:false` contract)    | ✅ `createChannel(cb)` — Tauri commands + listen (approximate unicast: `app.emit` broadcast per handle)                                      | ✅ JSI handle + `close()`                                                                 | ✅ JSI native channel handle + `{ pollMs }` polling fallback (CallInvoker-less)                                                             |
| Binary channels (`createBytesChannel`)    | ✅ `createNodeBytesChannel` — 0xfff9 frames (capability-gated; loud-fail `channel.unavailable` on old runtimes)                                                                       | ✅ `createBunChannelBytesBridge` — FFI `rustra_ffi_channel_create_bytes` (JS-thread send only — `threadsafe:false` contract) | ✅ `createChannelBytes` — `rustra://channel-bytes/{handle}` emit (bytes serialize as a JSON number array — ~4x wire cost, functional parity) | ✅ JSI `createChannelBytes` — ArrayBuffer copies                                          | ✅ same JSI bytes path + `{ pollMs }` fallback                                                                                              |
| Frame binary (`createFrameEngine`)        | ✅ (requires the napi/FFI native)                                                                                                                                                     | ✅ (requires the FFI native)                                                                                                 | ✅ (`rustra_dispatch` binary path)                                                                                                           | —                                                                                         | ✅ JSI                                                                                                                                      |

## Signal semantics in detail

- **Pre-abort**: every adapter rejects immediately with `cancelled` — the request has not been sent yet.
- **In-flight cancellation**:
  - JSON transports (Node/Bun/Tauri and the RN JSON adapter) forward the round trip to the native side and cannot interrupt execution itself. Under the **shallow cancellation policy** they reject only the JS Promise with `cancelled` and ignore late results.
  - The RN Frame engine **propagates** to the Rust checkpoint when `invokeAsync`+`invokeCancel` exist and the commandId/codec path is confirmed. Static typed paths, legacy natives, and paths where the commandId cannot be confirmed fall back to shallow cancellation.
- **Timeout** (`options.timeoutMs`): common to all engines — the global `invoke` starts a settle race. On expiry it rejects with `transport.timeout` (retryable) and late responses are ignored. A batch (`invokeBatch`) races the entire batch with the **minimum** of the per-entry `timeoutMs` values. The wire-batch (single-crossing) path applies the same per-entry contract as a single `invoke`: `timeoutMs: 0` counts as a deadline (the check is `!== undefined`, so a zero deadline is never silently dropped onto the single-crossing path), entry `args` pass through the same normalizer, and a synchronous throw from the transport or a custom normalizer surfaces as a rejected Promise instead of escaping the caller's `await`.
- **Shallow cancellation/timeout ≠ the command did not run**: the ⚠️ cells on shallow cancellation and `timeoutMs` mark the _JS observation_, not the Rust execution. On a shallow-cancel adapter (`signal` without `invokeCancel` propagation) or after a timeout, the Rust command keeps running or has already completed — its result is discarded, not its execution. `retryable: true` (`transport.timeout`, `cancelled`, `transport.error`) therefore means "the failure class may clear on a retry", never "re-running the command is safe". Retry non-idempotent commands only after a status re-query proves the earlier attempt did not land; see "Timeout, Cancellation, and Retry Semantics" in [rust-api-guide.md](rust-api-guide.md).
- **Event subscription call shape**: every adapter uses `(name, callback[, ...])`. RN accepts `subscribeEvent(name, callback[, options])` with the native module resolved from `globalThis.__rustraNative` (the legacy `(native, name, callback)` overload was removed in 0.7.0); Tauri accepts `subscribeEvent(name, callback[, listen])` with an optional `listen` injection or the global Tauri event API.
- **Event delivery path**: Tauri is a Rust `app.emit` **push**, RN is a JSI sink **push**, Bun is an FFI C callback sink **push** (`rustra_ffi_event_sink_register` — hosts that emit from background threads use the `poll` option's polling fallback), and Node is dual-mode: `subscribeEvent` prefers `events:"push"` handshake **push** over stdout 0xfffd frames when the loop-stdio runtime accepted it, falls back to `__drainEvents` special-command **polling** (`RUSTRA_NODE_EVENT_POLL_MS`, default 100ms) otherwise (legacy runtimes, no-codecs transports), and throws `event.unavailable` on transports that can never deliver events. Unlike polling, push mode (Node stdout, Bun FFI) discards emits that happen before the first subscription — the sink bypasses the bus, so subscribe before emitting or use polling if pre-subscription emits matter. When a Rust `set_event_sink` is installed the bus drains (the contract that prevents dual push+polling reception), so push and polling are not mixed. The RN JSON adapter's `subscribeEvent({ pollMs })` option runs the same drain loop client-side for CallInvoker-less natives whose C++ dispatcher queues events until JS calls `drainEvents()`.

### Channel delivery path

Every host exposes the same `{ handle, close() }` contract; only the issuer (transport) differs. Node issues channel handles through the loop-stdio binary-mode reservation frames (0xfffb create / 0xfffa drop / 0xfffc push) and is safe for background-thread `send` (stdout frames arrive as JS turn data events); NDJSON transports loud-fail with `channel.unavailable`. Bun issues through the `rustra_ffi_channel_*` FFI symbols with a `threadsafe:false` callback — sends must stay on the JS thread (synchronous FFI invoke chains); background sends are unsupported. Tauri issues through `rustra_channel_create`/`rustra_channel_drop` commands and delivers frames via `app.emit("rustra://channel/{handle}")` — **approximate unicast**: the channel contract is invocation-scoped unicast, but Tauri emit is a broadcast, so another webview listening on the same channel name can observe frames (single issuer = single listener is the normal flow). RN issues through the JSI `createChannel`/`dropChannel` host functions backed by the C++ callback dispatcher (true unicast); with a CallInvoker the dispatcher drains on the JS thread automatically, and on CallInvoker-less natives `drainEvents()` drains the channel queues too — `createChannel(cb, native, { pollMs })`/`createBytesChannel` run the same client-side polling loop as events (frames would otherwise queue unconsumed).

- **Tauri payload contract (decoded-first, string-only single parse)**: at the real WebView boundary tauri splices the `emit_str` JSON into the page as `payload: {…}`, so the JS listener already receives a decoded value — `subscribeEvent` passes any non-string payload through untouched (no re-parse, object identity preserved). Only `typeof payload === 'string'` gets exactly one `JSON.parse`; if the result is an object, array, or string it is delivered (an escaped-JSON string unwraps exactly once), and if the result is a primitive (`'123'`, `'true'`) the original string is kept — a string payload never silently changes type. Parse failure delivers the original string. There is no content-based sniffing: a string payload stays a string even when it looks like JSON. Legacy injected transports (`__TAURI__` fakes delivering serialized strings) are covered by the same rule, with no separate mode. One known divergence between the two delivery modes: primitive event payloads arrive as the primitive itself under the real WebView (`payload: 42`) but stay the original string (`'42'`) under a legacy-string transport — the production boundary is the real WebView.

## invokeBatch semantics

- Every adapter exposes a Promise-based `invokeBatch`. Node/Bun/Tauri/RN JSON run each entry through the common `invoke` and preserve order. The Frame engine bundles supported static commands into a single native crossing.
- Static commands without a signal → single JSI crossing (`invokeTypedBatchById` preferred).
- Mixed dynamic commands or a signal present → routed to per-entry `invoke` (each entry's cancellation policy applies).

## Notes

- **Verified combination**: npm `@rustra/types` 0.8.x ↔ Rust crate 0.8.x (workspace) is the combination currently exercised by CI. The npm and crates.io version lines were aligned in the 2026-09-06 release step; the `@rustra/*` packages are independent release lines, and future bumps follow the same release procedure, not adapter code.
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

| `supports` field    | Node        | Bun JSON / Bun FFI Frame  | Tauri       | RN JSON     | RN Frame          |
| ------------------- | ----------- | ------------------------- | ----------- | ----------- | ----------------- |
| `cancellation`      | `shallow`   | `shallow` / `shallow`     | `shallow`   | `shallow`   | `cooperative`     |
| `batch`             | `per-entry` | `per-entry` / `per-entry` | `per-entry` | `per-entry` | `single-crossing` |
| `events`            | `push`      | `push` / `push`           | `push`      | `none`      | `push`            |
| `channels`          | `false`     | `false` / `false`         | `false`     | `true`      | `true`            |
| `timeoutPreemption` | `true`      | `true` / `true`           | `true`      | `false`     | `true`            |

Nuances that do not fit one enum value stay in the matrix prose, not the enum:
RN Frame `cancellation: 'cooperative'` means the matrix's "conditional
propagation" cell (reaches the Rust checkpoint only when
`invokeAsync`+`invokeCancel` are exposed and the commandId/codec path is
confirmed; static typed paths and legacy natives fall back to shallow). The
Bun FFI Frame engine shares the same `createFrameEngine` core, but its FFI
native binds only `invokeFrame`/`getSchema`/`getContractHash`/
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

## UniFFI bindings (Track B1): typed Kotlin/Swift surface

The UniFFI surface is deliberately **not a column above**: the matrix keys TS
`EngineClient` adapters, while UniFFI bypasses the TS layer entirely — Kotlin
or Swift host code calls generated per-command functions over uniffi's own
RustBuffer transfer. The setup, codegen flow, and consumption are in the
[UniFFI bindings guide](extending/uniffi-bindings.md); this section transcribes
its coverage into the row grammar used above:

| Feature                                | UniFFI (Kotlin/Swift)                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-command typed invoke               | ✅ one generated function per command (`addNumbers(input:)` …) plus the generic `invokeJson`/`getSchema`/`contractHash`                                                      |
| `options.signal` (pre-abort/in-flight) | — no TS options surface; generated functions are synchronous (the Rust command API is sync today), so interruption is the host's concern                                     |
| `invokeBatch`                          | — not generated in Phase 1 (per-command surface only)                                                                                                                        |
| `options.timeoutMs`                    | — synchronous native calls cannot be preempted mid-call                                                                                                                      |
| Events (`subscribeEvent`/`onEvent`)    | — Phase 2 (uniffi callback interfaces / foreign traits)                                                                                                                      |
| Channels (`createChannel`/bytes)       | — Phase 2                                                                                                                                                                    |
| Frame binary wire                      | ✅ single dispatch path — the generated wrapper calls `Package::invoke_typed`, which posts a postcard request through `invoke_frame` (no second wire)                        |
| Contract integrity                     | ✅ uniffi's own checksums + contract version govern this surface; rustra's `contract_hash`/`contract.mismatch` gate stays scoped to the blob transports (Node/Bun/Tauri/JSI) |
| Hot swap                               | — uniffi hosts bind symbols at load time — static/release builds only; the dev loop stays on TS/JSI                                                                          |

Notes:

- **Error model**: a single-variant failure record
  `RustraCommandFailure.Failure { code, message, retryable }` — the same shape
  as the TS `RustraCommandError`. A uniffi enum mapping was rejected by design:
  rustra's error code space is open (custom string codes), and an enum would
  close it. Decision record: [ADR 0002](adr/0002-uniffi-track-b1-carrier.md).
- **Mirror layer is generated, not hand-written**: the schema probe renders the
  feature-gated `uniffi_generated.rs` (fail-closed renderer). Its mechanical
  divergences are documented in the guide: sets → `Vec` mirrors collected into
  real `BTreeSet`s, fixed tuples → synthetic records, maps by inference-based
  collect, `getSchema()` returns the live schema (generation counter included),
  and channel/resource handle newtypes map to `u32` via an explicit path table.
- **Freshness**: the committed `uniffi_generated.rs` is guarded by a byte
  comparison in `codegen --check` (no cargo build in check mode); the committed
  Kotlin/Swift bindings regenerate with the same flow.

## Spike: wasm32 engine in wasm3 (React Native) — VERDICT: PASS (spike)

Task A0 spike (`examples/rn-wasm-spike/`, 2026-08-31) proved a rustra engine
compiled to `wasm32-unknown-unknown` runs inside a wasm3 interpreter embedded
in a React Native app, as a THIRD execution mode alongside the JSON adapter and
Frame JSI:

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

> Superseded (2026-09-09): the native dlopen swap described below was later
> adopted experimentally as the `hot-core` feature — see
> [plans/2026-09-09-native-hot-core-design.md](plans/2026-09-09-native-hot-core-design.md).
> The section is preserved as a decision record.

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
