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
