# Benchmark Plan

Status: stress run 5 completed with native Protobuf invoke measurements.

The benchmark should answer one question:

> Is the local Rust engine boundary fast enough for coarse product commands, and clearly too slow for high-frequency UI work?

## Rules

- Measure from inside the iOS app.
- Do not use desktop curl numbers in the result table.
- Report p50, p95, p99, min, max, and average.
- Report wall-clock total time and throughput for high-frequency tests.
- Keep engine-internal elapsed time separate from RN-observed elapsed time.
- Mark simulator results separately from physical-device results.

## Scenarios

| Scenario                        |                         Count | Purpose                                    |
| ------------------------------- | ----------------------------: | ------------------------------------------ |
| `EngineLifecycle.start`         |                   20 restarts | native lifecycle overhead                  |
| `GET /health`                   |                200 sequential | lower-bound RN fetch overhead              |
| `bench.ping`                    |                500 sequential | JSON-RPC overhead                          |
| `bench.addNumbers`              |           500 / 1K sequential | high-frequency fine-grained total time     |
| `bench.addNumbers`              |                 1K / 2K burst | concurrent high-frequency throughput       |
| `bench.addNumbersLoop`          |  20 calls, each 100K Rust ops | coarse API benefit for same logical volume |
| `bench.bulkPing`                | 1 call with 1,000 logical ops | coarse API benefit                         |
| `document.write`                |      200 sequential, 2KB body | write command overhead                     |
| `document.read`                 |     200 sequential, 512B body | read command overhead                      |
| `document.search`               |  100 calls over 1K / 10K docs | realistic coarse command                   |
| `stream 100 events`             |                       20 runs | event streaming overhead                   |
| background -> foreground status |                       20 runs | lifecycle recovery                         |

## Comparison Targets

The comparison should be structured like this:

| Boundary          | Expected relative latency | What to measure                      |
| ----------------- | ------------------------- | ------------------------------------ |
| Direct JSI        | lowest                    | micro call overhead                  |
| Nitro             | very low                  | generated native call overhead       |
| Expo Module       | medium                    | async native module call overhead    |
| Local Rust Engine | highest per call          | RN fetch + JSON + localhost overhead |

The useful result is not "local engine is faster." It will not be faster per call. The useful result is:

```txt
Local engine is slower per call, but acceptable for coarse commands and much simpler to maintain.
```

## Pass / Fail Thresholds

Initial thresholds for the local engine approach:

| Metric               | Pass if                                |
| -------------------- | -------------------------------------- |
| engine start from RN | p95 < 50ms                             |
| health / ping        | p95 < 30ms on simulator                |
| coarse command       | p95 < 100ms for realistic search/write |
| repeated calls       | 0 network failures over 500 calls      |
| background recovery  | p95 < 100ms to ready/status            |

If repeated localhost calls keep failing, the architecture is not disproven. It means the toy server is invalid as a benchmark harness and should be replaced before drawing conclusions.

## Stress Run 3 High-Frequency Result

| Metric              | Calls | Concurrency | Failed |     p50 |     p95 |  Total | Interpretation                            |
| ------------------- | ----: | ----------: | -----: | ------: | ------: | -----: | ----------------------------------------- |
| fine addNumbers     |   500 |           1 |      0 | 16.67ms | 17.42ms |  8.40s | about 59.5 RPC/s                          |
| fine addStrings     |   500 |           1 |      0 | 16.67ms | 17.70ms |  8.38s | about 59.6 RPC/s                          |
| fine addNumbers     | 1,000 |           1 |      0 | 16.67ms | 18.53ms | 16.82s | linear growth                             |
| fine addNumbers     | 1,000 |          10 |      0 | 16.68ms | 17.35ms |  1.68s | throughput improves with concurrency      |
| fine addNumbers     | 2,000 |          20 |      0 | 17.71ms | 32.63ms |  2.18s | throughput improves, tail latency worsens |
| addNumbersLoop 100K |    20 |           1 |      0 | 16.66ms | 16.99ms |  0.33s | 100K work inside Rust costs about one RPC |

Projection:

```txt
100,000 individual sequential RPC calls at 59.5 RPC/s = about 28 minutes.
100,000 logical operations inside one Rust-side loop = about 16-17ms p50 in this toy benchmark.
```

Conclusion:

```txt
This architecture is viable only if high-frequency work is batched/coarsened before crossing into Rust.
It should not expose many tiny native-style methods over localhost RPC.
```

## Stress Run 4 Native Invoke Result

This run added a Tauri-like transport next to the HTTP transport:

```txt
RN JS -> RustEngine.invoke(payloadJson) -> Swift -> Rust FFI -> Rust dispatcher
```

JSON is still used. The goal was only to remove `fetch`, localhost TCP, and HTTP.

| Metric                            |                      Calls | Failed |     p50 |     p95 |   Total | Interpretation                  |
| --------------------------------- | -------------------------: | -----: | ------: | ------: | ------: | ------------------------------- |
| HTTP rpc ping                     |                        500 |      0 | 16.67ms | 19.19ms |   8.45s | baseline HTTP/fetch cost        |
| native addNumbers                 |                      1,000 |      0 |  0.07ms |  0.10ms | 80.07ms | native invoke JSON cost         |
| native addNumbers, concurrency 10 |                      1,000 |      0 |  0.23ms |  0.28ms | 24.31ms | high throughput, still low tail |
| native addNumbersBatch 1K         | 20 calls / 20K logical ops |      0 |  0.09ms |  0.43ms | 11.18ms | batch over native invoke        |
| native addNumbersLoop 100K        |  20 calls / 2M logical ops |      0 |  0.66ms |  0.77ms | 22.13ms | Rust owns the hot loop          |

Conclusion:

```txt
The Tauri-like in-process invoke transport is the right next architecture.
It preserves the small native bridge while removing the large HTTP/fetch penalty.
Run 5 then tested Protobuf as the first binary envelope.
```

## Stress Run 5 Native Protobuf Result

This run added a binary in-process transport next to native JSON:

```txt
RN JS -> RustEngine.invokeProtobuf(Uint8Array) -> Swift Data -> Rust FFI -> prost dispatcher
```

| Metric                                     |                      Calls | Failed |    p50 |    p95 |   Total | Interpretation            |
| ------------------------------------------ | -------------------------: | -----: | -----: | -----: | ------: | ------------------------- |
| native JSON addNumbers                     |                      1,000 |      0 | 0.07ms | 0.10ms | 87.29ms | JSON baseline in same run |
| native Protobuf addNumbers                 |                      1,000 |      0 | 0.08ms | 0.10ms | 92.50ms | similar, slightly slower  |
| native JSON addNumbers, concurrency 10     |                      1,000 |      0 | 0.24ms | 0.31ms | 33.47ms | burst JSON baseline       |
| native Protobuf addNumbers, concurrency 10 |                      1,000 |      0 | 0.46ms | 0.59ms | 48.50ms | binary path slower here   |
| native JSON addNumbersBatch 1K             | 20 calls / 20K logical ops |      0 | 0.08ms | 0.42ms | 10.61ms | batch JSON baseline       |
| native Protobuf addNumbersBatch 1K         | 20 calls / 20K logical ops |      0 | 0.11ms | 0.49ms | 15.11ms | binary path slower here   |
| native JSON addNumbersLoop 100K            |  20 calls / 2M logical ops |      0 | 0.71ms | 0.82ms | 22.15ms | Rust owns the hot loop    |
| native Protobuf addNumbersLoop 100K        |  20 calls / 2M logical ops |      0 | 0.68ms | 0.82ms | 24.65ms | p50 same class            |

Conclusion:

```txt
Removing HTTP/fetch is the dominant win.
Replacing JSON with Protobuf does not automatically improve tiny-call benchmarks through Expo Module Data/Uint8Array.
Protobuf should be judged again with generated codecs and larger structured payloads.
```

## Stress Run 1 Result

| Metric                         | Planned | Success | Failed |     p50 |     p95 | Interpretation                      |
| ------------------------------ | ------: | ------: | -----: | ------: | ------: | ----------------------------------- |
| lifecycle restart              |      20 |      20 |      0 |  0.29ms |  0.43ms | Pass                                |
| health fetch                   |     200 |     192 |      8 | 16.67ms | 17.50ms | Latency promising, reliability fail |
| rpc ping                       |     500 |     268 |    232 | 16.75ms | 17.43ms | Reliability fail                    |
| rpc ping burst, concurrency 10 |     200 |       1 |    199 | 35.76ms | 35.76ms | Hard fail                           |
| write 2KB                      |     200 |     113 |     87 | 16.70ms | 17.71ms | Reliability fail                    |
| write 64KB                     |      50 |      20 |     30 | 16.76ms | 17.67ms | Reliability fail                    |
| read 512B                      |     200 |     108 |     92 | 16.70ms | 17.35ms | Reliability fail                    |
| search 1K docs                 |     100 |      56 |     44 | 16.86ms | 17.46ms | Reliability fail                    |
| search 10K docs                |      50 |      27 |     23 | 16.71ms | 17.35ms | Reliability fail                    |
| coarse bulkPing                |      20 |      11 |      9 | 16.74ms | 17.38ms | Reliability fail                    |
| stream 100 events              |      20 |      19 |      1 | 16.70ms | 17.41ms | Mostly pass                         |

Conclusion:

```txt
Successful-call overhead is consistently around 16-18ms on simulator.
The lifecycle bridge is effectively negligible.
The current toy HTTP server fails reliability thresholds and must be replaced before final comparison.
```
