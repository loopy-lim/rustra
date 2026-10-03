# Rust Local Engine vs Native Bridge Options

Status: concept comparison with early iOS PoC evidence.

This document compares the proposed local engine architecture against common React Native native integration styles. The goal is not to prove that one approach is universally faster. The goal is to decide whether a Rust-owned local engine is good enough for coarse app work while avoiding broad native bridge maintenance.

## Options

| Option                 | Primary shape                                                                             | Best fit                                                            | Main cost                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Local Rust Engine      | RN starts a small native lifecycle module, then calls Rust over localhost HTTP / JSON-RPC | storage, search, sync, workflow, AI actions, coarse commands        | higher per-call latency, lifecycle and local server correctness |
| Tauri-like Rust Invoke | RN calls one native `invoke` function, then Rust dispatches commands in-process           | same Rust-owned command model without HTTP/fetch overhead           | one transport bridge plus schema/codegen ownership              |
| Nitro Module           | JS talks to C++/native through Nitro-generated bindings                                   | high-frequency native APIs, typed native calls, hot paths           | native build complexity and binding surface ownership           |
| Direct JSI             | custom C++ JSI host objects/functions                                                     | extremely low overhead hot paths                                    | highest maintenance burden and sharpest RN internals dependency |
| Expo Module            | Swift/Kotlin module exposed to JS                                                         | platform APIs, small native capability wrappers, Expo compatibility | each feature still needs native API surface design              |
| Craby/codegen bridge   | generated native bridge from a Rust/native contract                                       | typed bridge generation, reducing manual glue                       | generator maturity and contract/build pipeline complexity       |

## Decision Frame

The local engine approach is intentionally optimized for lower maintenance, not raw call overhead.

```txt
React Native UI
  -> tiny EngineLifecycle module
  -> localhost HTTP / JSON-RPC
  -> Rust engine
  -> storage / search / sync / workflow
```

This is the opposite of exposing every Rust function as a native module. The native bridge should ideally stay at:

```ts
start(): Promise<EngineInfo>
status(): Promise<EngineInfo>
stop(): Promise<boolean>
```

Everything else should be expressed as engine API methods.

## Qualitative Comparison

| Criterion                          | Local Rust Engine           | Nitro                     | Direct JSI             | Expo Module                   | Craby/codegen bridge        |
| ---------------------------------- | --------------------------- | ------------------------- | ---------------------- | ----------------------------- | --------------------------- |
| Per-call overhead                  | High                        | Low                       | Lowest                 | Medium                        | Low to medium               |
| Maintenance surface                | Low if APIs are coarse      | Medium                    | High                   | Medium                        | Medium                      |
| RN internals coupling              | Low                         | Medium                    | High                   | Low to medium                 | Depends on generator        |
| Rust core reuse on desktop         | High                        | Medium                    | Medium                 | Low to medium                 | Medium                      |
| API testability outside RN         | High                        | Low to medium             | Low                    | Low to medium                 | Medium                      |
| Works well with SQLite ownership   | High                        | Medium                    | Medium                 | Medium                        | Medium                      |
| Works well with streaming events   | High via HTTP/SSE/WebSocket | Medium                    | Medium                 | Medium                        | Depends                     |
| Best for frame-level calls         | Poor                        | Good                      | Excellent              | Poor to medium                | Depends                     |
| Best for product workflow commands | Good                        | Good but more bridge work | Possible but overbuilt | Possible but more module work | Good if generator is stable |

Updated transport interpretation:

| Criterion                | HTTP Local Engine                         | Native JSON Invoke                    | Native Protobuf Invoke                                    |
| ------------------------ | ----------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| Transport                | RN fetch -> localhost TCP -> HTTP -> Rust | RN native module -> Swift FFI -> Rust | RN native module `Uint8Array` -> Swift `Data` -> Rust FFI |
| API model                | server-style command/RPC                  | same server-style command/RPC         | same server-style command/RPC with binary envelope        |
| Native bridge surface    | lifecycle only                            | lifecycle plus one `invoke`           | lifecycle plus one `invokeProtobuf`                       |
| 1K sequential fine calls | 16.82s                                    | 87.29ms in run 5                      | 92.50ms in run 5                                          |
| 1K burst fine calls      | 1.68s                                     | 33.47ms in run 5                      | 48.50ms in run 5                                          |
| 100K Rust loop command   | about 16-17ms p50                         | 0.71ms p50 in run 5                   | 0.68ms p50 in run 5                                       |
| Best role                | external-debuggable coarse local service  | main mobile transport candidate       | schema/codegen candidate for larger payloads              |

## Practical Interpretation

Use Local Rust Engine when the API is naturally coarse:

- `document.open`
- `document.applyPatch`
- `document.search`
- `storage.queryBatch`
- `workflow.run`
- `sync.runOnce`
- `ai.runAction`

Avoid it for frame-level or high-frequency UI work:

- cursor movement
- selection updates
- scroll events
- animation frame callbacks
- per-line tokenization from JS
- per-block loops where each block is its own RPC

## Current Recommendation

Keep the local engine path as the main experiment for local-first product logic.

Use Nitro/JSI later only for proven hot paths where the local engine boundary is too slow or too awkward. That keeps the core architecture simple while preserving an optimization escape hatch.

The strongest version of this architecture is:

```txt
Rust owns durable state and heavy work.
RN owns immediate UI state.
Native bridge owns only engine lifecycle and platform permission UX.
```

## Current PoC Evidence

The iOS simulator PoC shows a clear split:

- Lifecycle bridge is very cheap: 20 stop/start cycles stayed under 1ms p99.
- After replacing the toy HTTP parser with `tiny_http`, repeated RN fetch/RPC calls completed with 0 failures in the stress run.
- Sequential localhost calls cluster around 16-18ms p50/p95, or roughly 59-60 RPC/s.
- 1,000 sequential fine-grained `addNumbers` RPC calls took 16.82s.
- 1,000 concurrent fine-grained `addNumbers` RPC calls at concurrency 10 took 1.68s.
- 2,000 concurrent fine-grained `addNumbers` RPC calls at concurrency 20 took 2.18s, but p95 rose to 32.63ms.
- A single Rust-side 100K loop still costs about one RPC, around 16-17ms p50 in the toy benchmark.
- The Tauri-like native invoke transport changed 1,000 sequential `addNumbers` calls to 80.07ms while still using JSON.
- Native invoke changed a 100K Rust loop command to 0.66ms p50 in the simulator run.
- The native Protobuf invoke path worked end-to-end, but tiny-message results were similar or slower than native JSON: 92.50ms for 1,000 sequential `addNumbers` calls and 48.50ms for the 1,000-call concurrency-10 burst.

Interpretation:

```txt
Fine-grained high-frequency calls must not cross the localhost HTTP boundary one by one.
The Tauri-like native invoke transport is the stronger mobile shape.
Protobuf is not an automatic tiny-call win through Expo Module Uint8Array/Data.
Product APIs should still be coarse enough for Rust to own the loop.
```

Projected from the 1,000-call sequential HTTP run, 100,000 individual RPC calls would take about 28 minutes. Native JSON invoke reduced that class of overhead by roughly 190-210x across runs. Native Protobuf invoke reduced it by about 182x in run 5, but did not beat native JSON for this tiny payload.
