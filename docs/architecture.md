English | [한국어](./architecture.ko.md)

# rustra-bridge Architecture

## Overview

rustra is a bridge framework that automatically generates a host-neutral TypeScript client once you define a Rust package. You write command functions on the Rust side and register them with a `Package`; `generate_typescript()` then produces TypeScript type definitions and command helper functions. The generated TypeScript code depends on no runtime (Node.js, Bun, Tauri, React Native); each host adapter receives an injected transport and wraps it behind the `EngineClient` interface.

---

## Overall Data Flow Diagram

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                         Rust (authoring time)                       │
 │                                                                     │
 │  #[command]                                                         │
 │  fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput>│
 │                                                                     │
 │         │                                                           │
 │         ▼                                                           │
 │  Package::builder("examples.calculator")                            │
 │      .register(add_numbers)                                         │
 │      .build()                                          Package      │
 │                                                             │       │
 │         ┌───────────────────────────────────────────────────┘       │
 │         ▼                                                           │
 │  package.generate_typescript()                                      │
 │         │                                                           │
 │         ▼                                                           │
 │  GeneratedPackage {                                                 │
 │      schema_json,      → schema.json                                │
 │      types_ts,         → types.ts    (EngineClient + I/O types)     │
 │      commands_ts,      → commands.ts (command helper functions)     │
 │      contract_hash,    → contract.ts (contract hash)                │
 │  }                                                                  │
 │                                                                     │
 │  generated.write_to_dir("./generated")                              │
 └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    TypeScript (runtime)                              │
 │                                                                     │
 │  generated/types.ts        generated/commands.ts                    │
 │  ┌──────────────────┐      ┌──────────────────────────────────┐     │
 │  │ EngineClient     │◄─────│ addNumbers({ a, b })             │     │
 │  │ AddNumbersInput  │      └──────────┬───────────────────────┘     │
 │  └──────────────────┘                 │                             │
 │          ▲                            │ invoke() (global)           │
 │          │                            │                             │
 │  ┌───────┴────────────────────────────┴───────────────────────┐     │
 │  │                    host adapter                             │     │
 │  │  generated node.ts → lazy Cargo binary                      │     │
 │  │  generated bun.ts → lazy cdylib + stable FFI                │     │
 │  │  generated tauri.ts → lazy global IPC                       │     │
 │  │  generated react-native.ts → lazy JSI + fast engine         │     │
 │  └──────────────────────────────┬─────────────────────────────┘     │
 │                                 │                                   │
 │                                 ▼                                   │
 │  ┌──────────────────────────────────────────────────────────────┐   │
 │  │  transport (app-level choice)                                 │   │
 │  │  subprocess stdio / C FFI / napi / Tauri IPC / RN JSI        │   │
 │  └──────────────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## EngineClient: The Core Contract of the System

`EngineClient` is the only contract between the generated TypeScript code and the host adapters. Every command helper function depends solely on this interface and contains no host-specific code.

```ts
// auto-generated into types.ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T>;
  invokeBatch?<T>(entries: BatchEntry[]): Promise<T[]>;
};
```

Each host adapter takes an injected transport and returns an object implementing this interface:

| Adapter package         | Factory function                         | Return type                         | File path                            |
| ----------------------- | ---------------------------------------- | ----------------------------------- | ------------------------------------ |
| `packages/node`         | `createNodeBootstrap(options)`           | lazy `EngineClient`                 | `packages/node/src/index.ts`         |
| `packages/bun`          | `createBunBootstrap(options)`            | lazy `EngineClient`                 | `packages/bun/src/index.ts`          |
| `packages/tauri`        | `createTauriBootstrap()`                 | lazy `EngineClient`                 | `packages/tauri/src/index.ts`        |
| `packages/react-native` | generated bootstrap + `createFastEngine` | `RkyvV2Engine`                      | `packages/react-native/src/index.ts` |
| `packages/react-native` | `createReactNativeEngine(native)`        | JSON `EngineClient` + `invokeBatch` | `packages/react-native/src/index.ts` |

All return types structurally provide `EngineClient`'s `invoke<T>`, and the adapter
factories also guarantee a Promise-based `invokeBatch`. An `AbortSignal` in flight is
a shallow cancellation on the JSON/synchronous paths; only on the RN async rkyv path,
and only when a native cancellation handle exists, does it propagate into Rust.

### Command Helper Usage Example

Each command helper generated in `commands.ts` does not take an engine directly —
it calls the generated paths from `@rustra/types` (`invokeGenerated*`). The default
platform entry point registers `configureLazy()`, and the first call installs the
engine exactly once. Manual `configure(engine)` is an explicit override.

```ts
// examples/calculator/generated/commands.ts (auto-generated, slightly simplified)
import { createGeneratedFields2 } from '@rustra/types';

export const addNumbers = createGeneratedFields2<AddNumbersInput, AddNumbersOutput>(
  1,
  'addNumbers',
  'a',
  'b',
  'addNumbers',
);
```

Usage example (Tauri):

```ts
// examples/tauri-calculator/src/app.ts
import { addNumbers } from '../../calculator/generated/commands.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';
import { configure } from '@rustra/types';

const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
configure(engine); // installs the engine into the global invoke
const result = await addNumbers({ a: 20, b: 22 });
```

---

## Crate and Package Relationships

### Rust Crates

```
crates/
├── rustra/              # core crate
│   └── src/lib.rs       # Package, PackageBuilder, GeneratedPackage, codegen, invoke, tauri_support
│
└── rustra-macros/       # proc-macro crate
    └── src/lib.rs       # #[command] attribute macro
```

#### `crates/rustra` (core)

Provides the core types and logic.

| Component          | Description                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Package`          | A collection of registered commands. Runtime dispatch via `invoke_json()`, code generation via `generate_typescript()`                                                 |
| `PackageBuilder`   | Created with `Package::builder(id)`. Register commands with `.command_fn(handler)` / `.command(name, handler)`, then `.build()`                                        |
| `GeneratedPackage` | The result of `generate_typescript()`. Holds the `schema_json`, `types_ts`, `commands_ts`, `contract_hash` fields. Writes files with `write_to_dir()`                  |
| `RustraError`      | Implements `Serialize`. `command.not_found`, `command.invalid_args`, `internal` error codes + a `custom(code, message)` constructor + `code()` and `message()` getters |
| `build!`           | Provided by `rustra-macros`. Registers multiple commands in one go as `rustra::build!("id", fn1, fn2).done()`                                                          |
| `tauri_support`    | Provided when `cfg(feature = "tauri")` is enabled. `RustraState`, the single `rustra_dispatch` Tauri command, and the `register()` builder injection function          |
| `__private` module | The `CommandInput`, `CommandOutput` sealed traits. Used by the proc macro to verify command type constraints at compile time. Not exposed as public API                |

#### `crates/rustra-macros` (proc-macro)

Provides the `#[command]` attribute macro. For the annotated function it:

1. Verifies that the function has at least one parameter
2. Auto-detects scalar parameter (two or more) vs struct parameter (one) mode
3. Statically verifies at compile time that the `rustra::__private::CommandInput` / `CommandOutput` trait bounds are satisfied
4. Allows an explicit command name via `#[command(name = "customName")]`. When omitted, the name is derived automatically by converting the function name with snake_to_lower_camel

The function body passes through unchanged (identity passthrough); only compile-time type checks are performed. It also generates the `const __RUstra_meta_{fn_name}: &str = "commandName"` constant so the `build!` macro can reference the command name.

The `build!` macro uses the metadata constants produced by `#[command]` to register several commands at once:

```rust
rustra::build!("my.pkg", add_numbers, multiply)
    .done()
```

### TypeScript Packages

```
packages/
├── node/           → generated node.ts + createNodeBootstrap
├── bun/            → generated bun.ts + createBunBootstrap
├── tauri/          → generated tauri.ts + createTauriBootstrap
└── react-native/   → generated react-native.ts + createRustraBootstrap
                     createReactNativeEngine({ invoke(ArrayBuffer) }): EngineClient (low-level JSON path)
```

Each adapter package never imports the others, and never imports host-specific packages directly. The low-level engine factories receive an injected transport, and the generated host entries lazily wire up the required transport and runtime.

### Example Projects

```
examples/
├── calculator/                 # basic Rust library example
│   ├── src/lib.rs              # command definitions + calculator_package() + C FFI entry point
│   ├── src/main.rs             # stdio entry point + codegen demo
│   └── generated/              # generate_typescript() output
│       ├── types.ts            # EngineClient + AddNumbersInput/Output types
│       ├── commands.ts         # addNumbers() helper
│       ├── contract.ts         # GENERATED_CONTRACT_HASH constant
│       └── schema.json         # JSON Schema representation
│
├── tauri-calculator/           # Tauri runtime example
│   ├── src/app.ts              # uses addNumbers from generated/tauri
│   └── src-tauri/src/main.rs   # registers the Package via tauri_support::register()
│
└── react-native-calculator/    # Expo React Native example
    ├── App.tsx                 # uses addNumbers from generated/react-native.ts
    └── modules/rustra-calculator  # native module (Expo module)
```

---

## Code Generation Pipeline

### Rust Side: Command Registration

```rust
// examples/calculator/src/lib.rs
#[bridge_type]
pub struct AddNumbersInput { a: i64, b: i64 }

#[bridge_type]
pub struct AddNumbersOutput { value: i64 }

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

pub fn calculator_package() -> Package {
    rustra::build!("examples.calculator", add_numbers).done()
}
```

`command_fn()` extracts the function's type name from the generic parameter (`command_name_from_handler::<F>()`). It strips the `_command` suffix from the last segment of the closure type name, then converts snake_case to lowerCamelCase.

`command()` lets you specify the name directly:

```rust
.command("myCommand", my_handler)
```

### The TypeScript Generation Process

When `package.generate_typescript()` is called:

1. **`schema_json`**: Serializes the metadata of all commands as JSON Schema. Each command includes `name`, `inputType`, `outputType`, `inputSchema`, and `outputSchema`.
2. **`contract_hash`**: The SHA-256 hash of `schema_json`. Used to confirm that Rust and TS are using the same contract.
3. **`types_ts`**: The `EngineClient` type definition plus each command's I/O types converted from the `schemars` JSON Schema into TypeScript types.
4. **`commands_ts`**: For each command, a helper function that calls `engine.invoke<OutputType>('commandName', input)`.

Type conversion rules (`ts_type_from_schema`):

| JSON Schema type     | TypeScript                |
| -------------------- | ------------------------- |
| `object`             | `{ property: type; ... }` |
| `integer` / `number` | `number`                  |
| `string`             | `string`                  |
| `boolean`            | `boolean`                 |
| `array`              | `itemType[]`              |
| anything else        | `unknown`                 |

`$defs` (shared definitions) are merged across all commands and then inlined. Currently the whole schema tree is converted directly, without extracting separate named types.

### File Structure of the Generated Output

Files written by `GeneratedPackage::write_to_dir(output_dir)`:

| File          | Content                                         | Purpose                                 |
| ------------- | ----------------------------------------------- | --------------------------------------- |
| `schema.json` | JSON Schema representation of the full contract | Debugging, tooling integration          |
| `types.ts`    | `EngineClient` + I/O type definitions           | What command helpers depend on          |
| `commands.ts` | Command helper functions                        | Imported and used by app code           |
| `contract.ts` | The `GENERATED_CONTRACT_HASH` constant          | Runtime contract integrity verification |

---

## Runtime Dispatch

The Rust `Package` provides two invoke interfaces:

```rust
// type-safe interface
pub fn invoke<I, O>(&self, name: &str, input: I) -> Result<O>

// JSON-based interface (used by FFI, IPC)
pub fn invoke_json(&self, name: &str, params: Value) -> Result<Value>
```

`invoke_json()` looks up the command by name in the internal `BTreeMap<String, Command>` and executes the closure created at registration time. Each `Command` deserializes the input JSON with `serde_json::from_value`, calls the handler, then serializes the result with `serde_json::to_value`.

---

## Transport Layer Separation Principles

```
┌──────────────────────────────────────────────────────────┐
 │  App code                                                │
 │  addNumbers({ a: 1, b: 2 })                             │
 │          │                                               │
 │          ▼                                               │
 │  invokeGenerated*(...)                                  │
 │  (global — generated host entry or configure(engine))    │
 │          │                                               │
 │          ▼                                               │
 │  host adapter (createXxxEngine)                          │
 │  - Node:      transport.invoke(command, args)            │
 │  - Bun:       transport.invoke(command, args)            │
 │  - Tauri:     invoke('rustra_dispatch', {command, args}) │
 │  - RN:        generated bootstrap → native.invokeRkyvV2(buf) │
 │          │                                               │
 │          ▼                                               │
 │  transport (created at app level)                         │
 │  - subprocess stdio  (examples/calculator/src/main.rs)   │
 │  - C FFI            (examples/calculator/src/lib.rs)     │
 │  - Tauri IPC        (rustra_support::rustra_dispatch)    │
 │  - RN JSI native    (@rustra/generated-react-native)     │
└──────────────────────────────────────────────────────────┘
```

Core principles:

1. **Adapters receive an injected transport**: adapter packages take a transport object as an argument and merely wrap it as an `EngineClient`; they do not create the transport themselves.
2. **The transport is decided at the app level**: the actual communication means — subprocess, FFI, napi, etc. — is chosen and configured by app code, not by the adapter.
3. **Transports can be swapped without swapping adapters**: the same adapter can be given a different transport, and vice versa.

### Tauri's Special Handling

Unlike the other adapters, the Tauri adapter does not pass commands through directly; it wraps them behind the single `rustra_dispatch` entry point:

```ts
// packages/tauri/src/index.ts
return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
```

This is because Tauri's IPC can only invoke pre-registered commands. The Rust-side `tauri_support` module registers the `rustra_dispatch` Tauri command as a single entry point and routes internally through `Package::invoke_json()`:

```rust
// crates/rustra/src/lib.rs (tauri_support module)
pub struct RustraState {
    pub package: Package,
}

#[tauri::command]
pub fn rustra_dispatch(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    state.package.invoke_json(&command, args).map_err(|e| {
        serde_json::to_value(&e)
            .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"}))
    })
}

pub fn register<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder
        .manage(RustraState { package })
        .invoke_handler(tauri::generate_handler![rustra_dispatch])
}
```

Usage example:

```rust
// examples/tauri-calculator/src-tauri/src/main.rs
let package = calculator_package();
let builder = rustra::tauri_support::register(package, tauri::Builder::default());
```

---

## Runtime Command Registry (dev / prod)

The inside of a `Package` is a mutable registry: `Arc<RwLock<RegistryState>>` + `Arc<AtomicBool> frozen`.

```rust
pub struct Package {
    id: String,
    state: Arc<RwLock<RegistryState>>,
    frozen: Arc<AtomicBool>,
}

struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16, // monotonically increasing; retired ids must never be reused
}
```

### dev / prod Split

At `build()` time, `frozen = !cfg!(debug_assertions)`:

| Build                      | `frozen` default | Runtime mutation                                        |
| -------------------------- | ---------------- | ------------------------------------------------------- |
| debug (`debug_assertions`) | `false`          | `register`/`register_fn`/`replace`/`unregister` allowed |
| release                    | `true`           | all rejected with `Err("registry.frozen")`              |

`Package::freeze()` seals the package explicitly at any time (e.g. simulating prod behavior in debug). Once frozen, it cannot be unfrozen.

### Mutation API

| Method                    | Behavior                                                                      | Failure                                     |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| `register(name, handler)` | Registers. Same name overwrites the handler (existing `command_id` preserved) | `registry.frozen` / `registry.id_exhausted` |
| `register_fn(handler)`    | Registers with the inferred name                                              | same as above                               |
| `replace(name, handler)`  | Replaces the handler (`command_id` preserved)                                 | `command.not_found` / `registry.frozen`     |
| `unregister(name)`        | Removes (`command_id` retired)                                                | `command.not_found` / `registry.frozen`     |

### Concurrency

- Reads (`invoke_json`, `invoke_rkyv_v2`, `generate_typescript`) take the read lock; mutations take the write lock.
- No lock is held while a handler runs (the `Command` is cloned out and the lock released). This prevents **re-entrant deadlock** where a handler calls `register`/`unregister` again.
- The prod read fast-path (uncontended `RwLock` read ≈ 10ns) is negligible next to the benchmark figure (3.8µs).

### Invocation Path for Dynamic Commands (single rkyvV2 engine + live schema)

- **Static postcard commands** (present in the C++/TS codec registry) → rkyv V2 postcard fast-path.
- **Static complex commands** (present in the TS registry and the native-safe C++ registry) →
  schema-driven complex binary `[command_id][body]` is marshalled in C++ JSI.
  Commands requiring Set or BigInt ranges do not advertise themselves as C++ static
  and use the same `invokeRkyvV2` boundary through the JS complex codec.
- **Runtime-registered commands** (not in the registry) → the TS engine **decides at
  runtime** (T2-3) which binary codec to use from the live schema: postcard-supported
  schemas use the schema interpreter codec (`createSchemaPostcardCodec`) as `[id][postcard]`,
  oneOf payload enums use the complex codec as `[id][variant index][body]`, and only
  schemas rejected by both postcard and complex (e.g. 3-arm untagged anyOf) fall back
  to **Tier 3 (JSON-in-binary)** as `[id][JSON]`. The Rust-side `register` picks the
  handler with the same 3-way decision, so both wire sides agree.
- A **single `createRkyvV2Engine`** handles postcard/complex/Tier 3 commands together.
  The codec decision is cached per live schema entry object, and when the generation
  gate re-checks (first call after a swap) commands whose schema changed are re-decided.

**live schema**: `Package::live_schema()` / `rustra_ffi_get_schema()` / JSI `getSchema()` return the schemas of all static+dynamic commands (`{name, commandId, inputSchema, outputSchema, definitions?}`). TS (`getLiveSchema`) looks up dynamic command ids/types. Read-only — in both debug and release.

> Design intent: the dynamic registry is for **dev (DX)** (slowness is acceptable). Release is frozen so no dynamic commands exist, and static commands keep the fast-path → no production performance impact.

### Verification/Measurement of the Dynamic Command Path (2026-07-05)

The dynamic import (Tier 3) + runtime registry path is covered by dedicated verification/measurement infrastructure across the full stack.

- **Per-type Rust wire tests** — `crates/rustra/tests/rkyv_v2_wire.rs`: round-trip verification of the static (postcard) Tier 1/2 and dynamic (Tier 3) paths over i64/f64/bool/String/Vec/HashMap/tuple/enum-with-data/Option/nested types + edge cases (empty collections, unicode, 10K payloads) + errors (truncated payload, unknown id, malformed JSON, frozen, invoke after unregister).
- **Property-based fuzzing** — `crates/rustra/tests/rkyv_v2_fuzz.rs` (proptest): round-trip preservation of random payloads.
- **Concurrency smoke** — `crates/rustra/tests/rkyv_v2_concurrency.rs`: no panics/deadlocks under mixed multi-threaded register/invoke/live_schema.
- **Performance benchmarks** — `crates/rustra/benches/` (criterion): `tier_compare` (static/dynamic postcard vs Tier 3 JSON — operation-controlled), `dynamic_registry` (register/live_schema/frozen costs), `type_scaling` (dynamic postcard payload scaling). Dynamic commands are dev-only, so measured with `--profile dev`. Figures are in the "dynamic commands" section of `docs/benchmarks.md`.
- **TS unit tests** — `packages/types/src/index.test.ts`: `createRkyvV2Engine` Tier 3 fallback + `getLiveSchema` (`bun run test:types`).
- **RN E2E** — `examples/react-native-calculator/DynamicRegistryApp.tsx` invokes four kinds of dynamic commands (Vec/String/Map/Nested) through the single rkyvV2 engine and shows live schema commandIds. For the run procedure see `docs/plans/2026-07-05-rn-verification-checklist.md`.

---

## Contract Invariants

rustra-bridge guarantees its host-neutral character through the following invariants:

1. **Generated TypeScript forbids host-specific imports**: `types.ts`, `commands.ts`, and `contract.ts` never import any host-specific module such as `node:`, `bun:`, `@tauri-apps`, `react-native`, or `expo-modules`. The only import is `commands.ts` referencing `types.js`.

2. **Adapter packages never import each other**: `packages/node`, `packages/bun`, `packages/tauri`, and `packages/react-native` are each independent, with no dependencies on one another.

3. **Adapters never import host packages directly**: adapter source (`src/index.ts`) does not import `node:child_process`, `@tauri-apps/api`, etc. Instead, the caller creates and injects the transport object.

4. **`EngineClient` is the only contract**: every generated command helper depends only on the `EngineClient` type. Calls go through `EngineClient`, not through concrete adapter types (`NodeEngineClient` etc.).

---

## Error Model

The Rust side represents errors with the `RustraError` struct. `Serialize` is implemented, so it can be serialized to JSON over Tauri IPC and similar channels:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RustraError {
    code: &'static str,   // "command.not_found" | "command.invalid_args" | "internal" | custom
    message: String,
}
```

**Constructors:**

| Method                                 | Error code             | Raised when                                                                     |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `RustraError::command_not_found(name)` | `command.not_found`    | `invoke_json()` cannot find a command with the given name in `Package.commands` |
| `RustraError::invalid_args(error)`     | `command.invalid_args` | `serde_json::from_value` deserialization fails                                  |
| `RustraError::internal(error)`         | `internal`             | `serde_json::to_value` serialization failure, I/O errors, etc.                  |
| `RustraError::custom(code, message)`   | the given code         | user-defined errors                                                             |

**Getters:**

| Method            | Return type    | Description             |
| ----------------- | -------------- | ----------------------- |
| `error.code()`    | `&'static str` | Reads the error code    |
| `error.message()` | `&str`         | Reads the error message |

`std::io::Error` is converted automatically into `RustraError::internal` through the `From` trait.

In Tauri, `rustra_dispatch` serializes `RustraError` into a JSON value (`{ code, message }`) and returns it. The TypeScript-side `createTauriEngine` converts that value into a `RustraCommandError` and throws it.

---

## Build and Code Generation Workflow

The typical development workflow:

```
1. Write the command functions on the Rust side
   #[command]
   fn my_command(input: MyInput) -> Result<MyOutput> { ... }

2. Register them with a Package
   Package::builder("my.package")
       .command_fn(my_command)
       .build()

3. Run code generation
   let package = my_package();
   let generated = package.generate_typescript()?;
   generated.write_to_dir("./generated")?;

4. Use the generated code on the TypeScript side
   import { myCommand } from './generated/commands.js';
   const result = await myCommand(engine, { ... });
```

`examples/calculator/src/main.rs` is an example that performs code generation at runtime:

```rust
let package = calculator_package();
let generated = package.generate_typescript()?;
generated.write_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;
```

---

## Compile-Time Type Safety

The `#[command]` macro performs compile-time validation of the function signature:

1. Confirms there is at least one input parameter
2. Confirms the input parameter is a typed parameter
3. Confirms the return type is `Result<O>`, a bare value, or `()`
4. Statically verifies the input type satisfies `CommandInput` (`DeserializeOwned + JsonSchema + 'static`)
5. Statically verifies the output type satisfies `CommandOutput` (`Serialize + JsonSchema + 'static`)

This validation goes through the sealed traits in the `__private` module and is not exposed as public API. Beyond validation, `#[command]` generates the `const __RUstra_meta_{fn_name}: &str` constant holding the command name, which the `build!` macro references.
