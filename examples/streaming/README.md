English | [한국어](./README.ko.md)

# Streaming Example — Rust → JS Event Push

An example showing the pattern where JS consumes events published with
`Package::emit()`. A long-running command streams progress, and the host adapter
polls the event bus and forwards events to the platform push channel.

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
bunx tsc -p examples/streaming/tsconfig.json
node dist-ts/examples/streaming/apps/node-app.js
```

Sample output:

```
[streaming] startJob(job-1, 5 steps)
[streaming] tick  1/5 (seq=0) ▓░░░░
...
[streaming] done: 5 steps
[streaming] PASS — 5/5 ticks received, seq 0..5
```

## API

```rust
// Rust — emit events from a command handler
package.emit("progress.tick", serde_json::json!({ "value": 42 }));
```

```ts
// Host adapter — poll the event bus (forward to the platform push channel)
const events = package.eventBus().takePendingEvents();
// → [{ name: "progress.tick", payload: "{\"value\":42}", seq: 0 }]
```

The event bus has a fixed capacity (default 1024, drop-oldest) — it never blocks the
Rust call even when the host is slow. seq increases monotonically, so it is used for
receive-side order verification.

## Other Platforms

- **Tauri**: polling timer → `app.emit()`
- **RN**: polling → `DeviceEventEmitter`

The `--serve` line daemon + `__drainEvents` polling of the Node demo is the reference
implementation of this role.
