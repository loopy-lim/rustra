English | [한국어](./getting-started.ko.md)

# Getting Started with rustra

rustra is a bridge framework that automatically generates a TypeScript client — working on Node, Bun, Tauri, and React Native alike — once you define a Rust package.

This guide aims to get a developer new to rustra building their first package and generating a TypeScript client within 10 minutes.

---

## 1. Installation

### The Fastest Start — `rustra init`

```bash
bunx --bun @rustra/cli init my-project
cd my-project
bun install
bun run doctor
bun run codegen      # generate schema.json + the full TS/C++ client
cargo build          # build the Rust binary the Node entry point runs
bun run demo         # call echo from TypeScript via the generated Node entry point
cargo run            # call echo directly from Rust
```

The scaffold creates a Cargo crate (an echo example command and a stdio contract probe) +
a `generate` bin + a first-call example in `src/index.ts` + a `rustra.json` with the
Node host configuration and a package.json (doctor/codegen/codegen:check/dev/demo
scripts), `.gitignore` (target/, node_modules/, dist/), and `tsconfig.json`. Before the
first call, the Node entry point compares the contract hash of the Rust binary and the
generated TS via `__rustra_contract`.

Re-running init in a directory with existing files blocks overwriting. Add `--force`
to replace them:

```bash
bunx --bun @rustra/cli init my-project --force
```

### Using in an External Project

```toml
[dependencies]
rustra = "0.4"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

For the TypeScript adapters, install only the environment you use:

```bash
bun add @rustra/node      # Node.js
bun add @rustra/bun       # Bun
bun add @rustra/tauri     # Tauri
bun add @rustra/react-native  # React Native
```

### Using in a Monorepo / Workspace

Workspace-based management is recommended for rustra. Add the following dependencies
to the top-level `Cargo.toml`.

```toml
[workspace.dependencies]
rustra = { path = "crates/rustra" }
rustra-macros = { path = "crates/rustra-macros" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = { version = "0.8", features = ["derive"] }
sha2 = "0.10"
hex = "0.4"
```

Then pull the workspace dependencies from your actual package crate (e.g.
`examples/calculator/Cargo.toml`).

```toml
[package]
name = "rustra-calculator-example"
edition.workspace = true
version.workspace = true
publish = false

[lib]
crate-type = ["rlib", "staticlib"]

[dependencies]
rustra.workspace = true
schemars.workspace = true
serde.workspace = true
serde_json.workspace = true
```

Only four crates are needed.

| crate                | Role                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| `rustra`             | Package builder, TypeScript generator, JSON Schema-based type mapping          |
| `rustra-macros`      | The `#[command]` attribute macro (re-exported automatically by rustra)         |
| `serde` + `schemars` | Serialization/deserialization + JSON Schema generation. Three derives per type |

---

## 2. Minimal Example: calculator

Explained step by step using the working `examples/calculator`.

### 2-1. Rust Type Definitions

Define the input and output structs. The keys are the **three derives** and
`#[serde(rename_all = "camelCase")]`.

```rust
use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}
```

Role of each derive:

- `Serialize` / `Deserialize` — serde-based serialization. Required for JSON exchange.
- `JsonSchema` — schemars generates the JSON Schema automatically. It is the basis for TypeScript type generation.
- `#[serde(rename_all = "camelCase")]` — automatically converts Rust `snake_case` field names to TypeScript `camelCase`. `a` and `b` are unaffected, but a field like `my_field` becomes `myField`.

### 2-2. Command Functions

Attach the `#[command]` macro to register a function as a command.

```rust
#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}
```

Rules:

- The input parameter is **exactly one**, received as a struct.
- The return type must be `Result<O>`. Use `rustra::prelude::Result`.
- The function name `add_numbers` is automatically converted to the camelCase command name `addNumbers`.

#### Specifying a Command Name Directly

You can specify the command name directly with the `name` attribute. When omitted, it is derived automatically from the function name via `snake_to_lower_camel` conversion.

```rust
#[command(name = "customName")]
pub fn my_function(input: MyInput) -> Result<MyOutput> {
    // command name: "customName"
    Ok(MyOutput { /* ... */ })
}
```

### 2-3. Package Builder

Bundle multiple commands into a single package.

#### Registering Individually

```rust
pub fn calculator_package() -> Package {
    Package::builder("examples.calculator")
        .command_fn(add_numbers)
        .build()
}
```

- `Package::builder("examples.calculator")` — the package identifier. Recorded as `packageId` in the generated `schema.json`.
- `.command_fn(add_numbers)` — registers the function as a command. The command name comes from the `name` attribute of the `#[command]` macro or is derived from the function name.
- `.command("customName", handler)` — lets you specify the name directly.
- `.build()` — creates the `Package` instance.

#### Batch Registration with the `register!` Macro

Use the `register!` macro to register multiple commands at once. List the command functions alongside `Package::builder()`.

```rust
use rustra::prelude::*;

fn main() -> Result<()> {
    let package = rustra::register!(Package::builder("my.pkg"), add_numbers, multiply)
        .build();

    // Generate TypeScript — publish the schema; the CLI renders the surfaces
    package.generate_typescript()?.write_schema_to_dir("generated")?;
    Ok(())
}
```

`register!` takes a `PackageBuilder` as its first argument and registers the listed functions one by one with `.command_fn()`. Each function must have the `#[command]` macro applied.

### 2-4. TypeScript Generation

One command renders every surface: `bun run codegen` (i.e. `rustra codegen --config rustra.json`).
The Rust side only publishes the contract — `src/bin/generate.rs` writes `schema.json`
(and nothing else), and the CLI renders the TypeScript/C++ artifacts from it, so there is
a single source of truth for generated code.

```rust
use rustra_calculator_example::{calculator_package, AddNumbersInput, AddNumbersOutput};

fn main() -> rustra::Result<()> {
    let package = calculator_package();

    // direct invocation from Rust also works
    let output: AddNumbersOutput = package.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", output.value);

    // contract probe: publish schema.json only — the CLI renders the TS/C++ surfaces
    package.generate_typescript()?.write_schema_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;

    Ok(())
}
```

Run it:

```bash
cargo run -p rustra-calculator-example
bun run codegen
```

Output:

```
2 + 3 = 5
```

The `generated/` directory then contains the five base files plus any configured host entry points.

---

## 3. Generated TypeScript Output

The `generated/` directory contains the following base files. Configuring `node`,
`bun`, `tauri`, or `reactNative` adds the corresponding host entry point.

### types.ts — Type Definitions

```ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type AddNumbersInput = {
  a: number | bigint; // i64 — widened to number | bigint for wire parity
  b: number | bigint;
};

export type AddNumbersOutput = {
  value: number | bigint;
};
```

- `EngineClient` — the common interface every host adapter implements. It has just `invoke`.
- Rust `i64` maps to TypeScript `number | bigint` (lossless restoration for values beyond 2^53).
- Thanks to `#[serde(rename_all = "camelCase")]`, field names are converted to camelCase automatically.
- **This file contains no host-specific dependencies whatsoever.** There are no imports like `node:`, `bun:`, `@tauri-apps`, or `react-native`.

### commands.ts — Command Helper Functions

```ts
import type { AddNumbersInput, AddNumbersOutput } from './types.js';
import { createGeneratedFields2 } from '@rustra/types';

// Commands with two fields are generated as a const form that passes the required fields directly on each call.
export const addNumbers = createGeneratedFields2<AddNumbersInput, AddNumbersOutput>(
  1,
  'addNumbers',
  'a',
  'b',
  'addNumbers',
);
```

- One TypeScript function is generated per `#[command]` function.
- The generated host entry point registers `configureLazy()`, so you do not pass an engine to each call.
- The command name (`addNumbers`), input type, and output type are all wired type-safely.

### contract.ts — Contract Hash

```ts
export const GENERATED_CONTRACT_HASH =
  '5ed9d6dc29fb1b0d437b110a8f48e0cb828cc1e27a562b79049e86975b970aba';
```

- The SHA-256 hash of the entire schema.
- Used to verify at runtime that the Rust and TypeScript sides share the same contract version.

### schema.json — JSON Schema

```json
{
  "commands": [
    {
      "name": "addNumbers",
      "inputType": "AddNumbersInput",
      "outputType": "AddNumbersOutput",
      "inputSchema": {
        "type": "object",
        "properties": {
          "a": { "type": "integer", "format": "int64" },
          "b": { "type": "integer", "format": "int64" }
        },
        "required": ["a", "b"]
      },
      "outputSchema": {
        "type": "object",
        "properties": { "value": { "type": "integer", "format": "int64" } },
        "required": ["value"]
      }
    }
  ],
  "packageId": "examples.calculator"
}
```

- The JSON Schema generated by schemars. Useful for runtime validation, automated documentation, and external tool integration.

---

## 4. Adapter Selection Guide

The generated TypeScript contract is host-independent. Ordinary apps do not build an
engine or call `configure()` themselves — the platform entry point installs the
`EngineClient` lazily.

### Node

Add a Node block to `rustra.json`. `rustra init` creates this configuration automatically.

```json
{ "schema": "./generated/schema.json", "output": "./generated", "node": {} }
```

```ts
import { addNumbers } from '../generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
```

Codegen pins the default binary and target directory from Cargo metadata. It prefers
Release and falls back to Debug; after transpilation it looks for the same Cargo target
in the parent of the current working directory. If the deployment directory differs,
set `RUSTRA_NODE_BINARY`. The standard runtime must implement the one-shot stdio
protocol `{command, args}` → `{ok, result}`. On top of that, the reserved `__rustra_contract`
command must return the current contract hash as a string for the generated Node entry
point's fail-fast check to pass. `run_invoke_stdio` in the calculator and the `rustra init`
scaffold is the reference implementation.

**Custom transports (napi-rs, etc.):**

```ts
import { createNodeEngine } from '@rustra/node';

const engine = createNodeEngine({
  invoke(command, args) {
    // your own transport, e.g. a direct napi addon call
    return nativeAddon.invoke(command, JSON.stringify(args));
  },
});
```

`createNodeEngine`, `createNodeProcessTransport`, and `createNodeLoopTransport` are the
explicit escape hatches for custom N-API and multiple runtimes.

### Bun

The Rust library declares `crate-type = ["rlib", "cdylib"]` and
`rustra::native_entry!(app_package)`. Leave an empty Bun block in the config.

```json
{ "schema": "./generated/schema.json", "output": "./generated", "bun": {} }
```

```ts
import { addNumbers } from '../generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });
```

The generated entry point inspects Release/Debug cdylib candidates down to the actual ABI
symbols and wires Bun FFI's stable C ABI into the rkyv V2 engine. The Rust response is
copied into a JS-owned `ArrayBuffer` and freed with the exact pointer/length. Specify a
different deployment layout with `RUSTRA_BUN_LIBRARY`.

### Tauri

Turn on Tauri's `app.withGlobalTauri` and add `"tauri": {}` to the config.

```ts
import { addNumbers, subscribeEvent } from '../generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
```

The Tauri adapter multiplexes all commands through the single `rustra_dispatch` endpoint internally. `createTauriEngine` wraps each command call as `invoke('rustra_dispatch', { command, args })`.

On the Rust side, register the package with the Tauri builder in one line via `rustra::tauri_support::register`.

```rust
// Tauri app main.rs
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(my_package(), tauri::Builder::default());
    builder.run(tauri::generate_context!()).expect("failed to run");
}
```

> **Note:** using `tauri_support` requires enabling the `tauri` feature in `Cargo.toml`.
>
> ```toml
> rustra = { path = "...", features = ["tauri"] }
> ```

### React Native

#### rkyv V2 (recommended — postcard binary + JSI synchronous calls)

Uses JSI synchronous calls and postcard binary serialization. On the Rust side, declare
the app package and native entry once.

**Rust-side setup:**

```rust
use rustra::prelude::*;

pub fn my_package() -> Package {
    register!(Package::builder("my.pkg"), add_numbers, multiply).build()
}

rustra::native_entry!(my_package);
```

In `Cargo.toml`, `[lib]` holds `crate-type = ["rlib", "staticlib"]`.

**Single configuration:**

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "positional": true,
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

```bash
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli codegen --config rustra.json
```

**TypeScript-side usage:**

```ts
import { addNumbers } from '../generated/react-native';

const result = await addNumbers({ a: 20, b: 22 }); // JSI fast path
```

On the first call, the generated entry point performs JSI installation, contract
hash/schema version verification, and `rkyvV2Registry` fast-engine setup exactly once
even under concurrent calls. Failed installs are retried on the next call, and an engine
explicitly `configure()`d by the app is never overwritten by a late-finishing install.
The generator infers the Cargo package/library and builds the Podspec, Gradle/CMake/JNI,
and shared C++ bridge into an app-specific `@rustra/generated-react-native` package.
Both Expo development builds and bare RN use standard autolinking, leaving no
install/configure boilerplate in app code. Expo Go is not supported.

2026-08-24 Release performance on the same public object operations is a 3-run median
against Nitro of add 1.0297x, string 1.0229x, bytes 0.9219x, pair 1.0656x. The latest
runner includes Nitro/Rustra/FFI rotation measurement, paired 95% CI, and diagnostics of
the generated helper/native paths, and a Bun command extracts the JSON receipt
automatically. For the comparison scope and feature parity matrix, see the
[benchmark document](benchmarks.md) §"Nitro Modules comparison".

**C++ codec codegen:** when `reactNative` is enabled, `rustra-generated-codecs.{hpp,cpp}`
is also placed inside the generated package automatically and included in the iOS and
Android builds. You never add the files to Xcode/Podspec/Gradle by hand. For details see
the [React Native setup guide](extending/react-native-setup.md).

The repository's React Native calculator example runs `bun run doctor` to inspect,
read-only, Bun 1.4, Rust schema and TypeScript/native codec synchronization, Expo/Pod
wiring, Rust iOS targets, static archive freshness, the required `extern "C"` symbols,
and the installed Release receipt. For each failure it tells you concretely which layer
to repair — `bun run codegen`, `cd ios && pod install`, `bun run rust:ios`, or a Release
rebuild — so native problems are not mistaken for TypeScript problems. Structured output
for CI is available via `bun run doctor -- --json`.

#### JSON (low-level transport compatibility)

```ts
import { createReactNativeEngine } from '@rustra/react-native';
import { configure } from '@rustra/types';
import { addNumbers } from '../generated/commands.js';
import { customNativeTransport } from './native-transport';

const engine = createReactNativeEngine(customNativeTransport);
configure(engine);

const result = await addNumbers({ a: 20, b: 22 });
```

Use this path only when you own a custom transport directly. Ordinary apps use the
caller-buffer fast path of the generated `react-native.ts`.

### Summary

| Environment  | Default generated entry point        | Auto wiring                         | Performance (release)                |
| ------------ | ------------------------------------ | ----------------------------------- | ------------------------------------ |
| Node         | `generated/node.ts`                  | Cargo binary + stdio                | ~3.4 ms historical; N-API is ~1.5 µs |
| Bun          | `generated/bun.ts`                   | Cargo cdylib + stable FFI + rkyv V2 | ~1.7 µs FFI                          |
| Tauri        | `generated/tauri.ts`                 | global invoke/event                 | IPC-dependent                        |
| React Native | generated `react-native.ts`          | autolinked JSI + postcard codecs    | Near Nitro; check the latest receipt |
| React Native | `createReactNativeEngine(transport)` | custom JSON transport               | Depends on transport implementation  |

> The ~24/27µs for Node/Bun are values when a debug native library is loaded —
> release builds narrow this to the single-digit µs range. For per-session figures see
> the [benchmark document](benchmarks.md) (2026-08-23 RN re-measurement).

Every adapter returns an `EngineClient`, so subsequent code is identical regardless of environment.

```ts
// The platform entry point import owns the bootstrap.
const result = await addNumbers({ a: 20, b: 22 });
```

---

## 5. Running and Testing

### Rust Tests

```bash
cargo test --workspace
```

Runs the unit tests of all crates.

### Verifying the TypeScript Output

```bash
cargo run -p rustra-calculator-example --bin generate   # contract probe: schema.json
bun run codegen                                          # render TS surfaces
```

Check that the TypeScript files were created in the `generated/` directory.

### Full Compatibility Test

```bash
bun run test:compat
```

This command runs all of the following:

| Script          | Content                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `test:ts:node`  | Validates the generated client types with Node                                             |
| `test:ts:bun`   | Validates the generated client types with Bun                                              |
| `test:adapters` | Confirms all 4 adapters pass commands correctly and identically                            |
| `test:runtime`  | Calls a real Rust process on Node/Bun, builds the Tauri app, and verifies calls in WebView |

Individual runs are also possible.

```bash
# Test the adapters only
bun run test:adapters

# Test the Node runtime only (includes the Rust build)
bun run test:runtime:node

# Test the Tauri runtime only
bun run test:runtime:tauri
```

---

## 6. Integrating the Generated TypeScript into a Project

How to use the generated files in a TypeScript project after code generation.

### Example Directory Layout

```
my-app/
├── rust-core/            # Rust package (uses rustra)
│   ├── Cargo.toml
│   ├── src/lib.rs
│   └── generated/        ← rustra generates TS here
│       ├── types.ts
│       ├── commands.ts
│       ├── contract.ts
│       └── schema.json
├── src/
│   └── app.ts            # imports the generated TS here
├── tsconfig.json
└── package.json
```

### tsconfig.json Configuration

If the generated files live outside the project, map them with `paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@generated/*": ["./rust-core/generated/*"]
    }
  }
}
```

### Build Pipeline

**Recommended approach: integrated codegen → TypeScript build**

```json
// package.json
{
  "scripts": {
    "doctor": "rustra doctor --config rustra.json",
    "codegen": "rustra codegen --config rustra.json",
    "codegen:check": "rustra codegen --config rustra.json --check",
    "build:ts": "tsc",
    "build": "bun run codegen && bun run build:ts",
    "dev": "rustra dev --config rustra.json"
  }
}
```

The `dev` script uses `rustra dev --config rustra.json` — the same scaffold `rustra init`
creates — and watches Rust source changes too, handling schema regeneration + TS
regeneration in one pass. If you only want to keep re-running the type check, add
`tsc --watch` as a separate script.

`rustra.json` names the Rust generator:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  }
}
```

Only when an existing project must keep its own subcommand, write `main.rs` to handle a
`generate` subcommand under `cargo run`:

```rust
fn main() -> rustra::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("generate") {
        let package = my_package();
        package.generate_typescript()?.write_schema_to_dir("generated")?;
    }
    Ok(())
}
```

### Contract Verification in CI

To confirm the generated files are in sync with the Rust code:

```bash
# Verifies everything from the Rust schema to the TS/C++ artifacts
bun run codegen:check
```

It fails if the manifest and the actual files differ by a single byte. The Rust schema
stage of `codegen --check` executes, but the TS/C++/RN verification stages write no files.

---

## 7. Error Handling

### Rust Side

Return errors as `RustraError`. `Serialize` is implemented, so it is serialized to JSON.

```rust
use rustra::prelude::*;

#[command]
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("division.by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
}
```

Error codes:

| Error code             | Raised when                                       |
| ---------------------- | ------------------------------------------------- |
| `command.not_found`    | Invoking a nonexistent command                    |
| `command.invalid_args` | Input JSON deserialization failure                |
| `internal`             | Internal error (serialization failure, I/O, etc.) |
| custom (your code)     | `RustraError::custom(code, message)`              |

### TypeScript Side

When a command call fails, the adapter throws. All host adapters (Node/Bun/Tauri/RN)
normalize it to `@rustra/types`' `RustraCommandError`, so there is exactly one
`instanceof` branch:

```ts
import { RustraCommandError } from '@rustra/types';
import { divide } from '../generated/node.js';

try {
  const result = await divide({ a: 10, b: 0 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code); // "division.by_zero"
    console.log(e.message); // "cannot divide by zero"
  }
}
```

`RustraCommandError` exposes `err.code` and `err.retryable`; timeouts/cancellations can
also be caught as the `TimeoutError`/`CancelledError` subclasses respectively. The
original transport error is preserved in `err.cause`.

---

## 8. TypeScript Type Mapping

Most Rust types convert correctly to TypeScript:

| Rust type                                     | TypeScript                         | Notes                                                      |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `String`, `&str`                              | `string`                           |                                                            |
| `i32`/`i64`/`u32`/`f32`/`f64`                 | `number` or `bigint`               | 64-bit integers restore as `bigint` outside the safe range |
| `bool`                                        | `boolean`                          |                                                            |
| `Option<T>`                                   | `T \| null` (fields optional `?`)  |                                                            |
| `Vec<T>`                                      | `T[]`                              |                                                            |
| `BTreeSet<T>` / `HashSet<T>`                  | `Set<T>`                           | `uniqueItems` — the JSON path serializes as arrays         |
| `(A, B, C)`                                   | `[A, B, C]`                        | Tuples                                                     |
| `HashMap<String, T>`                          | `Record<string, T>`                |                                                            |
| `enum` (unit variants)                        | `'VariantA' \| 'VariantB'`         | String enum literal union                                  |
| Nested structures (inside `Box<T>`, `Vec<T>`) | Resolved by definition name `$ref` | Including recursive types (self-reference)                 |
| `anyOf` / `oneOf`                             | `A \| B` (union join)              |                                                            |

`allOf` generates `A & B`, integer enums generate numeric literal unions, and
`oneOf`+`const` generates discriminated unions. The postcard fast path (rkyv V2 codec)
supports primitives, Vec/Set/tuples, maps of primitive values, string enums, nested
structs, and single-entry `allOf` newtype handles. Legacy schemas that cannot guarantee
declaration order via the schema's `fieldOrder: "declaration"` produce a codegen warning.

Data enums (payload variants of `oneOf`) that postcard does not handle, maps of struct
values, recursive structures, and Option wrapping collections/enums are generated with
the schema-driven complex binary codec. This path uses UTF-8 map key ordering,
declaration-order struct fields, deterministic variant keys, and depth/payload/collection
limits. Only schemas neither the generator nor Rust can support fall back to
JSON-in-binary (Tier 3); fields are never silently dropped.

Complex commands with a native-safe schema are marshalled directly by the RN C++ complex
codec, and native-safe wide-int paths including primitive-element `Set` and
`int64`/`uint64` are also in that scope. Commands outside the native-safe determination,
such as Sets of object/array elements, are carried by the JS complex codec through the
native `invokeRkyvV2` to the Rust handler. Both paths use the same complex wire.

---

## Summary: The Full Flow

```
Rust type definitions (Serialize + Deserialize + JsonSchema)
        |
        v
Write #[command] functions (the command name can be set directly via the name attribute)
        |
        v
Package::builder("id").command_fn(fn).build()
or register!(Package::builder("id"), fn1, fn2, ...).build()
        |
        v
package.generate_typescript()?.write_schema_to_dir("generated")   (schema.json only)
        |
        v
rustra codegen --config rustra.json                                (TS CLI renders every surface)
        |
        v
generated/
  types.ts       -- EngineClient + input/output types
  commands.ts    -- type-safe command helper functions
  contract.ts    -- contract hash
  schema.json    -- JSON Schema (published by the Rust probe)
        |
        v
From TypeScript, call createXxxEngine(transport) + configure(engine) + addNumbers(input)
```
