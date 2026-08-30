English | [한국어](./README.ko.md)

# Calculator napi-rs Example

An example that wraps a rustra package as a Node.js native addon (napi-rs).

## Overview

Turns the commands of the `rustra-calculator-example` package into a native addon that Node.js can call directly through napi-rs. Rust ↔ Node.js communication happens through JSON serialization.

## Run

```bash
# Debug build
bun run build:debug

# Release build
bun run build
```

## What the Example Shows

1. **napi-rs wrapping** — expose `rustra_calculator_example::calculator_package().invoke_json()` as a napi function
2. **JSON-based communication** — receive a command name and a JSON string, return the result as a JSON string
3. **Cross-platform build** — produce `.node` binaries on macOS, Linux, and Windows via napi-rs

## Key Files

| File         | Description                                                      |
| ------------ | ---------------------------------------------------------------- |
| `src/lib.rs` | Exposes the `rustra_invoke` function via the `#[napi]` attribute |
| `build.rs`   | napi-rs build configuration                                      |
| `Cargo.toml` | `cdylib` crate type, napi dependencies                           |

## Generated Function

```ts
const { rustraInvoke } = require('./calculator-napi.darwin-arm64.node');

const result = rustraInvoke('addNumbers', JSON.stringify({ a: 20, b: 22 }));
// '{"ok":true,"result":{"value":42}}'
```

## Prerequisites

- Rust toolchain
- `@napi-rs/cli` (installed automatically by the Bun scripts)
- `rustra-calculator-example` package (within the same workspace)
