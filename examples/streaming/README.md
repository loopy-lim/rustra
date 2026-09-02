English | [한국어](./README.ko.md)

# Streaming Example — Rust → JS Event Push

An example showing the pattern where JS consumes events published with
`Package::emit()`. A long-running command streams progress, and the host adapter
subscribes (`@rustra/node` `subscribeEvent`) and forwards events to the platform
push channel — this daemon is a legacy line-JSON runtime, so delivery flows
through the polling fallback (no `events:"push"` handshake).

## Structure

```
streaming/
├── src/lib.rs             startJob(background thread emit) + jobStatus
├── src/bin/invoke.rs      stdio line daemon(--serve) — __drainEvents polling command
├── apps/node-app.ts       Node end-to-end demo (progress bar output)
├── tests/streaming_flow.rs  Integration test (tick count/seq monotonicity/payload type)
└── ts/streaming.test.ts   Unit test (mock engine + generated verification)
```

## Run (end-to-end)

```bash
cargo build -p rustra-streaming-example
bun examples/streaming/apps/node-app.ts
```

Sample output:

```
[streaming] transport ready — mode=ndjson pushCapable=false (폴링 폴백 경로)
[streaming] startJob(job-1, 5 steps)
[streaming] tick  1/5 ▓░░░░
...
[streaming] done: 5 steps
[streaming] PASS — 5/5 ticks received via subscribeEvent
```

## API

```rust
// Rust — declare the event contract on the builder chain
rustra::build!("examples.streaming", start_job, job_status)
    .event::<JobProgress>("progress.tick")
    .event::<JobDone>("job.done")
    .done()

// Emit with the declared type from a command handler
package.emit("progress.tick", JobProgress { job_id, step, total });
```

```ts
// Host adapter — poll the event bus (forward to the platform push channel)
const events = package.eventBus().takePendingEvents();
// → [{ name: "progress.tick", payload: "{\"jobId\":\"job-1\",\"step\":1,\"total\":5}", seq: 0 }]
```

The event bus has a fixed capacity (default 1024, drop-oldest) — it never blocks the
Rust call even when the host is slow. seq increases monotonically, so it is used for
receive-side order verification.

## Other Platforms

- **Tauri**: polling timer → `app.emit()`
- **RN**: polling → `DeviceEventEmitter`

The `--serve` line daemon answers the `__drainEvents` polling command with the
`events` field (`{"ok":true,"events":[...]}`) — the same contract as the
calculator loop-stdio reference runtime, which is what `@rustra/node`'s polling
fallback reads. For a push-mode (0xfffd frame) runtime see
`examples/calculator/src/loop_stdio.rs`.
