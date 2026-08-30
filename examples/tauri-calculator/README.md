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
