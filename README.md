English | [Korean](./README.ko.md)

# rustra

One Rust core → type-safe clients for Node, Bun, Tauri, and React Native — over
a compact binary wire, gated by a contract that blocks breaking schema changes
in CI.

[![CI](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml/badge.svg)](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rustra/types)](https://www.npmjs.com/package/@rustra/types)
[![crates.io](https://img.shields.io/crates/v/rustra.svg)](https://crates.io/crates/rustra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Define once in Rust:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }
#[bridge_type]
struct AddNumbersOutput { sum: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}
```

Call from any host. `rustra codegen` emits a type-safe client per platform —
same contract, same binary wire:

```ts
import { addNumbers } from './generated/node.js';

const { sum } = await addNumbers({ a: 42, b: 58 });
```

No structs needed? The same core registers plain Rust functions too:

```rust
fn add(a: i32, b: i32) -> i32 { a + b }

let package = Package::builder("app.functions")
    .function("add", add)
    .build();
```

`PackageBuilder::function` registers a macro-free function with 0–12
positional arguments — no wrapper structs, no `#[bridge_type]`. When you need
async handlers or state injection, use the `#[command]` macro path instead.
Details: [function registration](docs/function-registration.md).

Every performance number below is quoted from verified in-repo receipts (see
[benchmark highlights](docs/marketing/benchmark-highlights.md)):

- Request payload: **4 B** on the Frame wire vs **47 B** as JSON — ~11.8×
  smaller (payload bytes, not end-to-end RTT)
- Core round trip: **134 ns** mean — ~8.9× faster than the JSON path
- Node N-API Frame hot path: **793,185 ops/s** (~2,188× the 363/s one-shot path)
- React Native: parity with a Nitro HybridObject within **±5%** (iOS simulator)

New here? [Getting started](docs/getting-started.md) has you make your first
Rust→TypeScript call in one command.

## How It Works

```
Rust #[command] definition → TypeScript client codegen → platform adapter execution
```

- Define functions with `#[command]` on the Rust side
- `generate_typescript()` publishes the contract as `schema.json`; `rustra codegen`
  renders type-safe TS client code from it
- Node, Bun, Tauri, and React Native adapters all route through the same
  `EngineClient` interface
- Plain Rust functions work too — `PackageBuilder::function` registers 0–12-argument
  functions without macros ([function registration](docs/function-registration.md))

## Why rustra (Comparison)

Tools that bridge a single Rust core to multiple JS hosts each make different
trade-offs:

|                                 | **rustra**                                                           | napi-rs                                                 | Nitro Modules | Tauri commands | tauri-specta |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- | ------------- | -------------- | ------------ |
| Single Rust core × multi-host   | ✅ Node/Bun/Tauri/RN                                                 | Node (+ Electron)                                       | RN-centric    | Tauri only     | Tauri only   |
| Type-safe codegen (both ways)   | ✅ commands+events                                                   | TS defs generated from Rust structs (attribute macros)¹ | ✅            | ❌ (manual)    | ✅           |
| Compact binary wire             | ✅ Frame ([11.8× smaller request wire vs JSON](docs/wire-format.md)) | JSON/Buffer                                             | JSI objects   | JSON IPC       | JSON IPC     |
| Contract gate (breaking change) | ✅ `rustra diff` + contract hash                                     | ❌                                                      | ❌            | ❌             | partial      |
| Cancel/timeout/batch semantics  | ✅ documented as a matrix                                            | DIY                                                     | DIY           | ❌             | ❌           |

rustra's choice: **own the whole RPC surface (definition → codegen → wire →
verification) as a single contract.** Command invocation and contract
verification stay common across hosts, while capability differences such as
cancellation, events, and channels are documented explicitly in the
[compatibility matrix](docs/compatibility-matrix.md).

¹ Verified against the napi-rs docs on 2026-09-05: napi-rs generates
TypeScript definitions from Rust structs via attribute macros (`#[napi(object)]`);
"manual" understated that. The rustra cell's distinct point is that types,
events, and the verification gates come from one shared schema across all
hosts, not that the others have no codegen.

## 5-Minute Quickstart

With Rust and Bun 1.4+ installed, create a project and run its first call:

```bash
bunx --bun @rustra/cli@0.12.0 init my-project --setup
# Bun FFI instead: bunx --bun @rustra/cli@0.12.0 init my-bun-project --host bun --setup
```

`--setup` generates the clients, installs dependencies, builds Rust, and runs the
scaffold's `echo` demo. Edit `my-project/src/lib.rs`, then run:

```bash
cd my-project
bun run start
```

`start` repeats setup and runs the demo; `bun run setup` prepares without running
it. If setup fails, fix the reported error and rerun the printed `rustra setup`
command. RN/Tauri setup prepares the integration and prints the remaining native
app steps; it does not establish device or WebView runtime acceptance.

To try this repository's checkout instead of the published packages, run
`bun run try:node` or `bun run try:bun` — it creates a separate example,
installs the checkout's packages, and runs the first Rust call.

Under the hood, the scaffold's Rust probe publishes `schema.json` and
`rustra codegen` renders every TS surface from it. The config is `rustra.json`
at the project root:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "node": {}
}
```

```bash
bunx --bun @rustra/cli@0.12.0 codegen --config rustra.json   # render all surfaces
bunx --bun @rustra/cli@0.12.0 dev --config rustra.json       # watch Rust + regen
bunx --bun @rustra/cli@0.12.0 generate --config rustra.json --check   # CI sync gate
```

→ Full walkthrough: the [getting-started guide](docs/getting-started.md)
([10-minute summary](docs/getting-started.md#10-minute-summary)).

### Installation

```toml
[dependencies]
rustra = "0.12.0"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

Installation versions follow the current Rust and npm manifests. Adapters have
independent versions; use the manifest-derived
[compatibility table](docs/compatibility-matrix.md) for installation.

```bash
bun add @rustra/node@0.11.0          # Node.js
bun add @rustra/bun@0.11.0           # Bun
bun add @rustra/tauri@0.10.0         # Tauri
bun add @rustra/react-native@0.10.0  # React Native
bun add @rustra/testing@0.7.2        # Mock engine (tests)
bun add @rustra/devtools@0.7.2       # Invocation observability (dev)
```

Upgrade native libraries, JS adapters, and generated output together — see the
[migration guide](docs/migration-guide.md) and the
[0.11 to 0.12 migration notes](docs/migrations/0.11-to-0.12.md).

## Details Live in the Docs

The previous README carried full sections here; each now has a home in the
docs and stays in sync through CI doc gates:

| Topic                                        | Where it lives now                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rust API (`#[command]`, `build!`, generics)  | [Rust API guide](docs/rust-api-guide.md)                                                                                   |
| Events and channels per host                 | [Events and channels guide](docs/events-and-channels.md)                                                                   |
| React Native setup (iOS JSI / Android)       | [RN setup guide](docs/extending/react-native-setup.md)                                                                     |
| Adding rustra to an existing Tauri app       | [Tauri setup guide](docs/extending/tauri-setup.md)                                                                         |
| Transport replacement (napi-rs, FFI)         | [Transport guide](docs/extending/transport-guide.md)                                                                       |
| Performance tables and receipts              | [Benchmarks](docs/benchmarks.md) · [benchmark highlights](docs/marketing/benchmark-highlights.md)                          |
| Wire format and the 11.8× claim scope        | [Wire format](docs/wire-format.md)                                                                                         |
| Roadmap status and release history           | [Roadmap spec](docs/specs/2026-09-14-rustra-roadmap.md) · [roadmap status](docs/verification/2026-09-16-roadmap-status.md) |
| Versioning and deprecation policy            | [Versioning policy](docs/versioning-policy.md)                                                                             |
| Migration notes (0.3→0.4, 0.5→0.6, post-0.9) | [Migration guide](docs/migration-guide.md) · [migration notes](docs/migrations/)                                           |
| Threat model and security audits             | [Threat model](docs/threat-model.md) · [security audit](docs/security-audit.md) · [security policy](.github/SECURITY.md)   |
| Per-host verification evidence               | [Verification checklist](docs/verification-checklist.md) · [compatibility matrix](docs/compatibility-matrix.md)            |
| Error codes and handling                     | [Error codes](docs/error-codes.md)                                                                                         |
| `rustra doctor` / `dev` / drift gates        | [Development hurdles guide](docs/development-hurdles.md)                                                                   |
| Architecture and transport separation        | [Architecture overview](docs/architecture.md)                                                                              |
| Crate and package structure                  | [Crate structure](docs/dev/internal/crate-structure.md)                                                                    |
| Runnable examples (Node/Bun/Tauri/RN)        | [Example gallery](docs/README.md#example-gallery)                                                                          |

## Real-World Examples

Generated host entrypoints own the connection, so no transport setup remains in
product code. All of the following call the same Rust `addNumbers` command.

```ts
// Node batch job — the default one-shot path suits low-frequency CLIs.
import { addNumbers, rustra } from './generated/node.js';

try {
  const { value } = await addNumbers({ a: 20, b: 22 });
  console.log(value);
} finally {
  rustra.dispose();
}
```

For servers with continuous request flow, use `createNodeLoopTransport`; for
microsecond-scale calls, choose the N-API Frame fast-path. Working code lives in
[`node-app.ts`](examples/calculator/apps/node-app.ts) and the per-performance-tier
picks in [`node-performance.ts`](examples/calculator/apps/node-performance.ts).
Bun FFI, Tauri WebView, and React Native JSI equivalents are in the
[example gallery](docs/README.md#example-gallery) — including the
[Tauri calculator](examples/tauri-calculator/) with a real WebView IPC receipt
and the [Expo](examples/react-native-calculator/App.tsx) /
[bare RN](examples/react-native-bare-calculator/App.tsx) calculators.

## Documentation

Full documentation lives in [`docs/`](docs/README.md) — the hub lists reading
paths for Tauri, React Native, and Node/Bun users.

| Doc                                                               | Contents                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                        | Installation, first package, adapter choice                               |
| [Events and channels guide](docs/events-and-channels.md)          | `subscribeEvent`/`createChannel` usage per host                           |
| [Architecture overview](docs/architecture.md)                     | Data flow, EngineClient contract, transport separation                    |
| [Transport swap guide](docs/extending/transport-guide.md)         | Bun FFI, Node napi-rs replacement                                         |
| [React Native setup guide](docs/extending/react-native-setup.md)  | iOS JSI module setup, usage, troubleshooting                              |
| [Tauri setup guide](docs/extending/tauri-setup.md)                | Adding rustra to an existing Tauri app, file by file                      |
| [Development hurdles guide](docs/development-hurdles.md)          | doctor, integrated codegen, drift, native boundary, mock engine           |
| [API reference (generated)](docs/README.md#api-reference-typedoc) | Browsable TypeDoc HTML for every `@rustra/*` package — `bun run docs:api` |
| [Adding a new host guide](docs/extending/adding-host.md)          | Adding new adapters like Electron, Deno                                   |
| [Full doc index](docs/README.md)                                  | Reading paths for users / contributors                                    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Repo development prerequisites and
workspace commands (Rust 1.95.0, Node 22.6+, Bun 1.4+) are documented there and
in the [getting-started prerequisites](docs/getting-started.md#prerequisites).
