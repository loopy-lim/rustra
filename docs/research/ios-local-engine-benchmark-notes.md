# iOS Local Engine Benchmark Notes

Status: stress run 7 complete with Tauri-like single `invoke(command, args)` wrapper measurements.

This file records only measurements taken from inside the iOS React Native app. Desktop `curl` checks were used only to debug server behavior and are not benchmark evidence.

Craby/Nitro와의 한글 비교표는 `docs/rn-rust-native-bridge-comparison.ko.md`에 따로 정리했다. JSON command + binary payload 구조는 `docs/json-command-binary-payload-architecture.ko.md`에 정리했다. Tauri-like single invoke 구조는 `docs/tauri-like-single-invoke-architecture.ko.md`에 정리했다.

## Test Path

```txt
iOS Simulator / React Native
  -> fetch("http://127.0.0.1:<random-port>")
  -> embedded Rust tiny_http server
  -> in-memory document store
  -> JSON response
```

Native bridge path:

```txt
React Native
  -> Expo local module RustEngine.start()
  -> Swift FFI
  -> Rust rust_engine_start()
  -> Rust starts localhost engine thread
```

Native Protobuf path:

```txt
React Native
  -> RustEngine.invokeProtobuf(Uint8Array)
  -> Expo Module / Swift Data
  -> Rust FFI rust_engine_invoke_protobuf(bytes)
  -> Rust prost decode / dispatch / prost encode
  -> Uint8Array response
```

Tauri-like single invoke wrapper path:

```txt
React Native
  -> RustEngine.invoke(command, args)
  -> wrapper builds JSON-RPC envelope
  -> plain object: NativeRustEngineModule.invoke(payloadJson)
  -> Uint8Array attachment: NativeRustEngineModule.invokeBinary(commandJson, bytes)
  -> Swift FFI
  -> Rust dispatcher
```

## Current Environment

| Item | Value |
| --- | --- |
| Date | 2026-05-13 |
| Host | macOS with Xcode 26.2 |
| Simulator | iPhone 17, iOS 26.2 |
| RN | 0.81.5 |
| Expo | 54.0.33 / 54.0.34 native pods |
| JS engine | Hermes via Expo/RN default |
| Rust target | `aarch64-apple-ios-sim` |

## Stress Run 7 Tauri-Like Single Invoke Wrapper

This run keeps the native JSON/binary/protobuf transports, but changes the public app API to:

```ts
RustEngine.invoke<T>(command, args)
```

The wrapper hides the transport choice. Plain JSON args go through native JSON invoke. Args containing one `Uint8Array` go through the binary attachment path. Protobuf remains exposed only as `RustEngine.native.invokeProtobuf` for legacy comparison.

Measurements were collected from inside the iOS RN app on 2026-05-13. A local benchmark collector received one JSON record per metric after each metric finished; the collector is not in the per-call hot path.

| Metric | Calls | Failed | p50 | p95 | p99 | Total | Calls/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lifecycle restart | 20 | 0 | 0.26ms | 0.37ms | 0.37ms | 105.98ms | 188.7 |
| HTTP health fetch | 200 | 0 | 16.64ms | 17.82ms | 18.29ms | 3.33s | 60.0 |
| single invoke JSON addNumbers | 1,000 | 0 | 0.07ms | 0.10ms | 0.14ms | 78.72ms | 12,703.7 |
| single invoke JSON addNumbers burst, concurrency 10 | 1,000 | 0 | 0.26ms | 0.31ms | 0.55ms | 27.73ms | 36,057.0 |
| single invoke JSON addNumbersBatch 1K | 20 | 0 | 0.09ms | 0.30ms | 0.30ms | 10.95ms | 1,827.0 |
| single invoke JSON addNumbersLoop 100K | 20 | 0 | 0.64ms | 0.72ms | 0.72ms | 20.06ms | 996.9 |
| native Protobuf addNumbers | 1,000 | 0 | 0.07ms | 0.08ms | 0.10ms | 82.93ms | 12,058.8 |
| native Protobuf addNumbers burst, concurrency 10 | 1,000 | 0 | 0.44ms | 0.51ms | 0.73ms | 45.27ms | 22,091.6 |
| binary echo 256KB through `invoke(command, args)` | 50 | 0 | 0.21ms | 0.44ms | 0.65ms | 25.68ms | 1,946.8 |
| binary invert 256KB through `invoke(command, args)` | 50 | 0 | 1.99ms | 2.12ms | 2.41ms | 111.37ms | 448.9 |
| binary checksum 1MB through `invoke(command, args)` | 20 | 0 | 3.60ms | 3.88ms | 3.88ms | 83.22ms | 240.3 |
| HTTP addNumbers 1K sequential | 1,000 | 0 | 16.66ms | 17.99ms | 19.78ms | 16.67s | 60.0 |
| HTTP addNumbers 1K burst, concurrency 10 | 1,000 | 0 | 16.67ms | 17.12ms | 17.53ms | 1.67s | 600.4 |
| HTTP addNumbers 2K burst, concurrency 20 | 2,000 | 0 | 16.67ms | 17.40ms | 24.72ms | 1.70s | 1,177.5 |

Important comparisons:

| Comparison | Result |
| --- | ---: |
| HTTP 1K sequential addNumbers / single invoke 1K sequential addNumbers | `16,665.71ms / 78.72ms = about 212x` faster |
| single invoke JSON 1K sequential / Protobuf 1K sequential | JSON was about 5% faster in total time |
| single invoke JSON 1K burst / Protobuf 1K burst | JSON was about 1.63x faster in total time |
| Run 5 native JSON 1K sequential / Run 7 single invoke JSON 1K sequential | `87.29ms -> 78.72ms`, same performance band, slightly faster in this run |
| 1MB checksum via hidden binary attachment | p50 3.60ms, still viable for media-probe style commands |

The single public API did not hurt the native invoke performance band. The wrapper adds a small JS routing step, but the measured `addNumbers` hot path stayed around 0.07ms p50 and 78.72ms for 1,000 sequential calls.

The strongest conclusion is unchanged: the product API should be coarse Rust-owned commands. Single invoke is good DX, but high-frequency logical work should still be batched inside one command instead of crossing the RN/native boundary repeatedly.

### Run 7 Performance Improvement Candidates

| Priority | Candidate | Expected effect | DX impact |
| ---: | --- | --- | --- |
| 1 | Keep `invoke(command, args)` as the only public execution API | prevents bridge surface explosion | positive |
| 2 | Prefer coarse commands and `ops: []` batch commands | removes repeated Promise/native/JSON boundary cost | positive if command names stay domain-level |
| 3 | Use file URI/resource handles for video and multi-MB data | avoids repeated `Uint8Array` copies | positive if hidden behind invoke args |
| 4 | Rust command-specific typed deserialization instead of broad `serde_json::Value` lookup | reduces Rust-side JSON dispatch cost | neutral |
| 5 | Add multi-attachment support in wrapper | enables image pairs, model inputs, document bundles | positive if automatic |
| 6 | Release build + physical iPhone benchmark | separates Debug/simulator noise from real throughput | no API impact |
| 7 | Only if needed: optional native hot path for a tiny set of primitive commands | reduces AsyncFunction/JSON overhead further | risky; avoid unless profiling proves need |

The next practical optimization is not JSI. It is `invoke("domain.applyOps", { ops: [...] })`, `invoke("media.probe", { input: { type: "file", uri } })`, and typed Rust command handlers behind the same single invoke facade.

## Stress Run 2 Results

These numbers are from the app UI / Metro run on 2026-05-12. The old hand-written HTTP server was replaced with `tiny_http` and a 4-worker request loop before this run.

| Metric | Planned | Success | Failed | p50 | p95 | p99 | Avg | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lifecycle restart | 20 | 20 | 0 | 0.31ms | 0.44ms | 0.44ms | 0.32ms | 0.23ms | 0.44ms |
| health fetch | 200 | 200 | 0 | 16.66ms | 17.35ms | 17.62ms | 16.66ms | 13.16ms | 18.89ms |
| rpc ping | 500 | 500 | 0 | 16.67ms | 17.69ms | 20.75ms | 16.70ms | 8.50ms | 33.41ms |
| craby addNumbers RPC | 500 | 500 | 0 | 16.67ms | 17.70ms | 18.87ms | 16.73ms | 10.55ms | 33.24ms |
| craby addStrings RPC | 500 | 500 | 0 | 16.68ms | 18.59ms | 21.29ms | 16.67ms | 10.24ms | 22.49ms |
| addNumbersLoop 100K | 20 | 20 | 0 | 16.68ms | 17.29ms | 17.29ms | 16.48ms | 11.68ms | 21.44ms |
| addStringsLoop 100K | 20 | 20 | 0 | 16.70ms | 19.10ms | 19.10ms | 16.74ms | 11.77ms | 20.35ms |
| types roundtrip | 100 | 100 | 0 | 16.69ms | 17.56ms | 19.04ms | 16.65ms | 13.77ms | 21.62ms |
| state increment | 200 | 200 | 0 | 16.70ms | 17.53ms | 18.64ms | 16.75ms | 12.89ms | 32.99ms |
| error reject | 50 | 50 | 0 | 16.66ms | 17.37ms | 17.72ms | 16.95ms | 14.28ms | 32.84ms |
| rpc ping burst, concurrency 10 | 200 | 200 | 0 | 16.65ms | 17.71ms | 17.75ms | 16.68ms | 15.13ms | 17.88ms |
| write 2KB | 200 | 200 | 0 | 16.67ms | 17.51ms | 17.93ms | 16.66ms | 12.64ms | 20.67ms |
| write 64KB | 50 | 50 | 0 | 16.66ms | 17.99ms | 20.50ms | 16.99ms | 12.33ms | 33.23ms |
| read 512B | 200 | 200 | 0 | 16.67ms | 17.42ms | 17.68ms | 16.74ms | 10.72ms | 32.40ms |
| search 1K docs | 100 | 100 | 0 | 16.65ms | 17.54ms | 18.38ms | 16.64ms | 13.23ms | 19.55ms |
| search 10K docs | 50 | 50 | 0 | 16.66ms | 17.24ms | 17.45ms | 16.64ms | 15.36ms | 17.49ms |
| coarse bulkPing, 1000 logical ops | 20 | 20 | 0 | 16.75ms | 17.28ms | 17.28ms | 16.71ms | 15.78ms | 17.48ms |
| stream 100 events | 20 | 20 | 0 | 16.73ms | 17.61ms | 17.61ms | 16.64ms | 8.96ms | 23.41ms |

## Stress Run 3 High-Frequency Totals

This run changed the benchmark UI to record wall-clock `totalMs` and throughput. These are still measured inside the iOS React Native app, not through desktop curl.

| Metric | Calls | Concurrency | Failed | p50 | p95 | Total | RPC/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| health fetch | 200 | 1 | 0 | 16.66ms | 17.41ms | 3.37s | 59.4 |
| rpc ping | 500 | 1 | 0 | 16.68ms | 17.96ms | 8.40s | 59.5 |
| fine addNumbers | 500 | 1 | 0 | 16.67ms | 17.42ms | 8.40s | 59.5 |
| fine addStrings | 500 | 1 | 0 | 16.67ms | 17.70ms | 8.38s | 59.6 |
| fine addNumbers | 1,000 | 1 | 0 | 16.67ms | 18.53ms | 16.82s | 59.5 |
| fine addNumbers | 1,000 | 10 | 0 | 16.68ms | 17.35ms | 1.68s | 595.6 |
| fine addNumbers | 2,000 | 20 | 0 | 17.71ms | 32.63ms | 2.18s | 916.6 |
| addNumbersLoop 100K | 20 | 1 | 0 | 16.66ms | 16.99ms | 0.33s | 60.5 |
| addStringsLoop 100K | 20 | 1 | 0 | 16.66ms | 16.84ms | 0.33s | 60.0 |
| rpc ping burst | 200 | 10 | 0 | 16.66ms | 17.52ms | 0.33s | 599.1 |

The important total-time comparison:

| Work shape | Observed total |
| --- | ---: |
| 1,000 individual `addNumbers` RPC calls, sequential | 16.82s |
| 1,000 individual `addNumbers` RPC calls, concurrency 10 | 1.68s |
| 2,000 individual `addNumbers` RPC calls, concurrency 20 | 2.18s |
| 20 RPC calls, each doing 100,000 Rust additions | 0.33s |
| One RPC call doing 100,000 Rust additions | about 16.66ms p50 |

Projected from the 1,000-call sequential run, 100,000 individual RPC calls would take roughly:

```txt
100,000 / 59.5 RPC/s = 1,681s = about 28 minutes
```

That is the architectural boundary in one number: high-frequency fine-grained calls must not cross this HTTP/RPC boundary one by one.

## Stress Run 4 Tauri-Like Native Invoke

This run keeps the existing HTTP/local-server path and adds a second transport:

```txt
RN JS
  -> RustEngine.invoke(payloadJson)
  -> Expo Module / Swift
  -> Rust FFI rust_engine_invoke(payloadJson)
  -> same Rust JSON-RPC dispatcher
```

The point of this run is not to remove JSON yet. It isolates the cost of `fetch + localhost TCP + HTTP` by keeping the JSON command envelope mostly the same.

| Metric | Calls | Failed | p50 | p95 | p99 | Total | RPC/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTP health fetch | 200 | 0 | 16.67ms | 19.92ms | 32.92ms | 3.40s | 58.8 |
| native addNumbers | 1,000 | 0 | 0.07ms | 0.10ms | 0.12ms | 80.07ms | 12,489.1 |
| native addNumbers burst, concurrency 10 | 1,000 | 0 | 0.23ms | 0.28ms | 0.34ms | 24.31ms | 41,127.4 |
| native addNumbersBatch 1K | 20 calls / 20K logical ops | 0 | 0.09ms | 0.43ms | 0.43ms | 11.18ms | 1,789.5 calls/s |
| native addNumbersLoop 100K | 20 calls / 2M logical ops | 0 | 0.66ms | 0.77ms | 0.77ms | 22.13ms | 903.5 calls/s |
| HTTP rpc ping | 500 | 0 | 16.67ms | 19.19ms | 24.74ms | 8.45s | 59.2 |

Important comparison:

| Work shape | HTTP/fetch transport | Native invoke transport |
| --- | ---: | ---: |
| 1,000 fine `addNumbers` calls, sequential | 16.82s in run 3 | 80.07ms |
| 1,000 fine `addNumbers` calls, concurrency 10 | 1.68s in run 3 | 24.31ms |
| 100K Rust additions inside one command | about 16-17ms p50 over HTTP | 0.66ms p50 over native invoke |

The native invoke path is about 210x faster than sequential HTTP/fetch for 1,000 fine calls in this simulator run:

```txt
16,816.92ms / 80.07ms = about 210x
```

This validates the Tauri-like direction: keep server-style commands and a Rust dispatcher, but move the transport in-process instead of using localhost HTTP.

## Stress Run 5 Native Protobuf Invoke

This run keeps both previous transports and adds a binary envelope:

```txt
RN JS
  -> encode ProtoRequest to Uint8Array
  -> RustEngine.invokeProtobuf(bytes)
  -> Expo Module / Swift Data
  -> Rust FFI
  -> prost decode / Rust dispatcher / prost encode
```

The point of this run is to remove JSON from the in-process invoke path while preserving the same command-style API.

| Metric | Calls | Failed | p50 | p95 | p99 | Total | Calls/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTP health fetch | 200 | 0 | 16.71ms | 19.93ms | 23.28ms | 3.35s | 59.7 |
| native JSON addNumbers | 1,000 | 0 | 0.07ms | 0.10ms | 0.15ms | 87.29ms | 11,456.7 |
| native JSON addNumbers burst, concurrency 10 | 1,000 | 0 | 0.24ms | 0.31ms | 0.46ms | 33.47ms | 29,879.5 |
| native JSON addNumbersBatch 1K | 20 calls / 20K logical ops | 0 | 0.08ms | 0.42ms | 0.42ms | 10.61ms | 1,885.1 calls/s |
| native JSON addNumbersLoop 100K | 20 calls / 2M logical ops | 0 | 0.71ms | 0.82ms | 0.82ms | 22.15ms | 903.1 calls/s |
| native Protobuf addNumbers | 1,000 | 0 | 0.08ms | 0.10ms | 0.13ms | 92.50ms | 10,810.6 |
| native Protobuf addNumbers burst, concurrency 10 | 1,000 | 0 | 0.46ms | 0.59ms | 0.84ms | 48.50ms | 20,619.9 |
| native Protobuf addNumbersBatch 1K | 20 calls / 20K logical ops | 0 | 0.11ms | 0.49ms | 0.49ms | 15.11ms | 1,323.2 calls/s |
| native Protobuf addNumbersLoop 100K | 20 calls / 2M logical ops | 0 | 0.68ms | 0.82ms | 0.82ms | 24.65ms | 811.2 calls/s |
| HTTP rpc ping | 500 | 0 | 16.71ms | 19.94ms | 25.76ms | 8.41s | 59.5 |
| HTTP addNumbers | 500 | 0 | 16.72ms | 20.60ms | 23.82ms | 8.37s | 59.8 |
| HTTP addStrings | 500 | 0 | 16.69ms | 20.87ms | 22.93ms | 8.35s | 59.9 |

Important comparison:

| Work shape | HTTP/fetch transport | Native JSON invoke | Native Protobuf invoke |
| --- | ---: | ---: | ---: |
| 1,000 fine `addNumbers` calls, sequential | 16.82s in run 3 | 87.29ms | 92.50ms |
| 1,000 fine `addNumbers` calls, concurrency 10 | 1.68s in run 3 | 33.47ms | 48.50ms |
| 100K Rust additions inside one command | about 16-17ms p50 over HTTP | 0.71ms p50 | 0.68ms p50 |

In this small-message benchmark, Protobuf did not beat native JSON. It was roughly equivalent for sequential fine calls and Rust-owned loops, but slower for the burst and batch cases:

```txt
native JSON sequential 1K: 87.29ms
native Protobuf sequential 1K: 92.50ms

native JSON burst 1K: 33.47ms
native Protobuf burst 1K: 48.50ms
```

The likely reason is that the payload is tiny, and the JS-side manual Protobuf encode/decode plus `Uint8Array` marshaling costs as much as or more than JSON stringify/parse through the Expo Module path. Protobuf is still useful if the payload becomes larger, schema stability matters, or generated codec/codegen removes the hand-written JS codec overhead.

## Stress Run 6 JSON Command + Binary Payload

This run keeps JSON as the command/control envelope, but sends media-like data as `Uint8Array` / Swift `Data` / Rust bytes instead of JSON string or base64.

```txt
RN JS
  -> commandJson: method, id, params
  -> payload: Uint8Array
  -> Expo Module / Swift Data
  -> Rust FFI rust_engine_invoke_binary(commandJson, bytes)
  -> binary response or JSON metadata response
```

| Metric | Calls | Failed | p50 | p95 | p99 | Total | Calls/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| binary echo 256KB | 50 | 0 | 0.21ms | 0.50ms | 0.74ms | 25.54ms | 1,957.4 |
| binary invert 256KB | 50 | 0 | 2.04ms | 2.24ms | 2.94ms | 114.17ms | 438.0 |
| binary checksum 1MB | 20 | 0 | 3.85ms | 4.10ms | 4.10ms | 87.69ms | 228.1 |

Important comparison:

| Work shape | Result | Meaning |
| --- | ---: | --- |
| 256KB bytes pass-through | 0.21ms p50 | image-sized byte payload can cross the native/Rust boundary cheaply in this simulator run |
| 256KB binary transform | 2.04ms p50 | Rust output allocation and byte-wise transform dominate more than command JSON |
| 1MB binary scan, JSON metadata output | 3.85ms p50 | media probe/checksum-style commands are viable without base64 strings |

Conclusion after run 6: for media-like inputs, JSON should stay as the control plane only. The data plane should be bytes for small/medium payloads and file URI/handle based for large video assets.

## High-Frequency Interpretation

The test is not trying to benchmark Craby itself. It uses simple `addNumbers` and `addStrings` methods only because they isolate boundary overhead from real work.

The useful comparison for this architecture is:

| Test | What it means here | Result |
| --- | --- | --- |
| `bench.addNumbers` repeated RPC calls | high-frequency fine-grained boundary crossing | sequential total grows linearly at about 59-60 RPC/s |
| `bench.addNumbers` burst RPC calls | high-frequency concurrent boundary crossing | better wall-clock throughput, but p95 rises at higher concurrency |
| `bench.addNumbersLoop` 100K in one RPC | coarse command shape where Rust owns the loop | one 100K loop still costs about one RPC, around 16-17ms p50 |
| `bench.addStringsLoop` 100K in one RPC | coarse command shape with repeated Rust-side string work | also boundary-dominated in this toy loop |
| `types.roundtrip` | JSON equivalent of type conversion coverage | works for number/string/boolean/object/array/null |
| `state.increment` | stateful module equivalent | works |
| `error.reject` | error propagation equivalent | works |

Conclusion after run 5: fine-grained high-frequency RPC is the wrong shape over HTTP/fetch, but a single in-process native `invoke` transport changes the viability envelope substantially. Coarse commands are still the right product API shape. Protobuf works end-to-end, but this tiny-payload run shows that removing JSON is not automatically faster than native JSON through Expo Module `Uint8Array` / Swift `Data`.

Craby docs were used only to identify the kind of micro-call workload to mirror, not as the benchmark target. Sources: [Craby introduction](https://craby.rs/docs/get-started/introduction), [Craby types](https://craby.rs/docs/guides/types), [Craby file I/O](https://craby.rs/docs/guides/file-io), [Craby stateful modules](https://craby.rs/docs/guides/stateful-modules).

## Stress Run 1 Results

These numbers are from the app UI / Metro logs, not from desktop curl. The table separates successful request latency from failures. Failures mean RN `fetch` reported `Network request failed` before the scenario completed.

| Metric | Planned | Success | Failed | p50 | p95 | p99 | Avg | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lifecycle restart | 20 | 20 | 0 | 0.29ms | 0.43ms | 0.43ms | 0.33ms | 0.19ms | 0.57ms |
| health fetch | 200 | 192 | 8 | 16.67ms | 17.50ms | 17.69ms | 16.68ms | 15.68ms | 18.32ms |
| rpc ping | 500 | 268 | 232 | 16.75ms | 17.43ms | 17.75ms | 16.74ms | 15.47ms | 17.93ms |
| rpc ping burst, concurrency 10 | 200 | 1 | 199 | 35.76ms | 35.76ms | 35.76ms | 35.76ms | 35.76ms | 35.76ms |
| write 2KB | 200 | 113 | 87 | 16.70ms | 17.71ms | 19.25ms | 17.01ms | 11.47ms | 49.75ms |
| write 64KB | 50 | 20 | 30 | 16.76ms | 17.67ms | 17.67ms | 16.85ms | 15.91ms | 17.84ms |
| read 512B | 200 | 108 | 92 | 16.70ms | 17.35ms | 17.77ms | 16.75ms | 15.72ms | 17.83ms |
| search 1K docs | 100 | 56 | 44 | 16.86ms | 17.46ms | 17.66ms | 16.76ms | 15.71ms | 17.69ms |
| search 10K docs | 50 | 27 | 23 | 16.71ms | 17.35ms | 17.86ms | 16.69ms | 15.27ms | 18.43ms |
| coarse bulkPing, 1000 logical ops | 20 | 11 | 9 | 16.74ms | 17.38ms | 17.38ms | 16.75ms | 16.20ms | 17.68ms |
| stream 100 events | 20 | 19 | 1 | 16.70ms | 17.41ms | 17.41ms | 16.70ms | 15.65ms | 17.49ms |

Important caveat for stress run 1: the latency numbers are only for successful requests. The hand-written HTTP server was not stable enough under repeated RN fetch calls, especially concurrency. This failure rate meant the first harness was not production-grade and should not be used as the final architecture benchmark.

## What The Result Suggests

The startup numbers are encouraging. Starting the embedded Rust engine itself is effectively negligible in this prototype, and the RN-to-native lifecycle restart loop stayed below 1ms p99 on simulator.

The HTTP boundary is visibly slower than a native bridge would be. Successful calls cluster around 16-18ms p50/p95 for most scenarios. This approach should not be used for high-frequency UI loops.

For coarse commands, the number may still be acceptable:

```txt
One document.search taking 20-50ms can be fine.
Hundreds of getBlock calls at 16ms each is not fine.
```

The surprising result is that payload size and naive in-memory search did not dominate the observed number. `write 64KB`, `search 1K docs`, and `search 10K docs` all stayed near the same 16-18ms successful-call band. In this prototype, the boundary overhead dominates more than the toy Rust work.

The reliability result changed materially after replacing the toy server: the second run had 0 failures across sequential RPC, burst RPC, file-like document operations, state, errors, and stream tests.

## Invalid / Debug-Only Checks

These must not be used as comparison results:

- Desktop `curl /health`
- Desktop `curl /rpc`
- Rust `engineElapsedMs` alone

Those checks only prove that the Rust server can respond on localhost. They do not include React Native, Hermes, RN fetch, simulator networking, or JS scheduling overhead.

## Current Benchmark Gaps

Remaining gaps:

- Run the same suite on a physical iPhone.
- Add real SQLite/file-system persistence instead of the in-memory document map.
- Add background/foreground recovery measurements.
- Add a release build run, because this run used Debug simulator.
- Compare against a small real Nitro/Craby sample in the same app/device environment if exact apples-to-apples numbers are needed.
