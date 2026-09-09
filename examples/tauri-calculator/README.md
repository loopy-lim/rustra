English | [한국어](./README.ko.md)

# Tauri Calculator Example

An example that integrates a rustra package into a Tauri 2 desktop application.

## Overview

A one-line Rust-side registration plus the generated TypeScript entrypoint wires up
Tauri IPC and event push. The frontend has no engine creation or `configure()`.

## Run

```bash
# Production build
bun run build

# Build frontend only
bun run build:frontend

# Runtime smoke test
bun run smoke

# Measure 3,000 generated API calls in a real hidden WebView
bun run bench
```

### Hot-core dev mode (experimental)

Without re-running `tauri dev`, Rust handler edits swap into the running app.
The bridge crate is `examples/calculator`, but the dev config is dedicated to
this example (`rustra.hot.json`) so the shared calculator config keeps its
default `native` target:

```bash
# Terminal 1 — watch + codegen + cdylib build + parity gate + gated publish
rustra dev --config rustra.hot.json

# Terminal 2 — the app loads and watches the gated live artifact instead of
# static linking. Use the exact RUSTRA_HOT_CORE path rustra dev prints
# (target/debug/librustra_calculator_example-hot-live.dylib in this workspace).
RUSTRA_HOT_CORE=../../target/debug/librustra_calculator_example-hot-live.dylib bunx tauri dev
```

A swap is reported on stderr with the old/new contract hashes. Channel and
resource tables live in the swapped core, so they are re-established after a
swap. See `docs/plans/2026-09-09-native-hot-core-design.md`; macOS today,
iOS Simulator-class targets later.

The automated smoke (`bun run smoke`) verifies the pipeline headlessly — hot
config resolution, cdylib build, gated publish, and a real host boot that opens
the published dylib and starts the watch thread. A live swap needs a rebuilt
artifact, so exercise the full swap loop manually with the two terminals above.

## What the Example Shows

1. **Tauri integration** — automatic command registration via `tauri_support::register(package, builder)`
2. **Zero-config frontend** — `generated/tauri.ts` lazily detects global invoke/event
3. **Real screen code** — reflects `result.value` of command results into the DOM and subscribes to events
4. **WebView performance receipt** — repeats real `rustra_dispatch` IPC 3 times after a warm-up

## Key Files

| File                    | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `src-tauri/src/main.rs` | Registers the rustra package with the Tauri builder + probe mode |
| `src-tauri/Cargo.toml`  | Enables the `tauri` feature of the `rustra` crate                |
| `src/app.ts`            | Screen using generated commands and events                       |
| `rustra.hot.json`       | Dev config for the hot-core (dylib) loop                         |
| `runtime-smoke.mjs`     | Automated runtime smoke test                                     |
| `src/benchmark.ts`      | Measures real WebView IPC accuracy and latency                   |
| `benchmark.mjs`         | Runs the hidden app + collects local receipts                    |

## Rust-Side Setup

```rust
use rustra::tauri_support;
use rustra_calculator_example::calculator_package;

let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

## TypeScript-Side Usage

```ts
import { addNumbers, subscribeEvent } from '../calculator/generated/tauri.js';

await subscribeEvent('calc.tick', console.log);
const { value } = await addNumbers({ a: 20, b: 22 });
document.querySelector('output').value = String(value);
```

The Tauri config uses `app.withGlobalTauri: true`, and `rustra.json` uses `"tauri": {}`.
Only existing apps that intentionally turned the global API off use
`createTauriEngine({ invoke })` as an escape hatch.

## Current Measurements

On 2026-08-24, macOS arm64 Release, the generated WebView IPC averaged 279.04µs,
p50 300µs, and about 3,584 ops/s. Because the WKWebView timer has roughly 1ms
granularity, percentiles are computed from per-call values of 20-call batches.
This includes Tauri UI IPC cost, so it is not the same boundary as a direct Rust
call or the Node/Bun native ABI figures.

## Prerequisites

- Rust toolchain
- Tauri CLI 2.0+ (`bun add -g @tauri-apps/cli`)
- `rustra-calculator-example` package (within the same workspace)
