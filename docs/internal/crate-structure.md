English | [한국어](./crate-structure.ko.md)

# Crate and Package Structure

Internal documentation for project contributors. Summarizes the
responsibilities, public APIs, and build dependency relationships of each
crate/package.

---

## Cargo Workspace Configuration

The root `Cargo.toml` configures the workspace.

- **resolver**: `"3"`
- **edition**: `"2024"` (applied wholesale through workspace.package)
- **license**: MIT
- **version**: managed in the workspace `Cargo.toml` at release time. This document does not pin a version.

### Workspace Members

| Member path                           | Package name                | Role                                                                    |
| ------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `crates/rustra`                       | `rustra`                    | Core library. Package builder, TypeScript codegen, command registration |
| `crates/rustra-macros`                | `rustra-macros`             | `#[command]` proc macro. Compile-time signature verification            |
| `examples/calculator`                 | `rustra-calculator-example` | Calculator example. Built as cdylib/staticlib and used from RN/FFI      |
| `examples/tauri-calculator/src-tauri` | (Tauri app)                 | Tauri backend. Uses rustra's `tauri` feature                            |

### Workspace Dependencies

```toml
[workspace.dependencies]
rustra-macros = { path = "crates/rustra-macros" }
rustra = { path = "crates/rustra" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = { version = "0.8", features = ["derive"] }
sha2 = "0.10"
hex = "0.4"
```

---

## Build Dependency Graph

```
rustra-macros (proc-macro)
  ├─ syn 2 (full)
  ├─ quote 1
  └─ proc-macro2 1
        │
        ▼
rustra
  ├─ rustra-macros (workspace)
  ├─ schemars 0.8 (derive)
  ├─ serde 1 (derive)
  ├─ serde_json 1
  ├─ sha2 0.10
  ├─ hex 0.4
  └─ tauri 2 (optional, feature = "tauri")
        │
        ▼
rustra-calculator-example
  ├─ rustra (workspace)
  ├─ schemars (workspace)
  ├─ serde (workspace)
  └─ serde_json (workspace)
        │
        ▼
tauri-calculator (src-tauri)
  └─ rustra (workspace, features = ["tauri"])
```

---

## Crate Details

### rustra (`crates/rustra`)

The core library. The entry point where users assemble a Package and generate
TypeScript clients.

**Public API:**

| Item                                  | Kind                   | Description                                                                                                           |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Package`                             | struct                 | Runtime object holding the registered commands                                                                        |
| `Package::builder(id)`                | method                 | Creates a `PackageBuilder`                                                                                            |
| `Package::invoke()` / `invoke_json()` | method                 | Executes a command (typed / JSON)                                                                                     |
| `Package::generate_typescript()`      | method                 | Produces a `GeneratedPackage`                                                                                         |
| `PackageBuilder`                      | struct                 | Registers commands with the builder pattern                                                                           |
| `PackageBuilder::command()`           | method                 | Registers a command with an explicit name                                                                             |
| `PackageBuilder::command_fn()`        | method                 | Derives the command name automatically from the function name                                                         |
| `PackageBuilder::build()`             | method                 | Creates a `Package`                                                                                                   |
| `GeneratedPackage`                    | struct                 | The generated TS client (4 files)                                                                                     |
| `GeneratedPackage::write_to_dir()`    | method                 | Writes the files to a directory                                                                                       |
| `RustraError`                         | struct                 | Error type. Implements `Serialize`. `code + message` fields + `custom()` constructor + `code()` / `message()` getters |
| `command`                             | macro (re-export)      | `rustra_macros::command`                                                                                              |
| `register`                            | macro (re-export)      | `rustra_macros::register`. Batch-registers multiple commands                                                          |
| `prelude`                             | module                 | Batch import of frequently used items (including `command`, `register`)                                               |
| `tauri_support`                       | module (feature-gated) | `RustraState`, `rustra_dispatch`, `register()` — Tauri integration helpers                                            |
| `__private`                           | module (sealed)        | `CommandInput`, `CommandOutput` traits. For proc macros only                                                          |

**Features:**

- `tauri` — enables the `tauri_support` module. Adds the `tauri` crate as a dependency.

**Key private functions (internal behavior):**

| Function                           | Description                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `schema_value::<T>()`              | Builds JSON Schema + definitions with `schema_for!(T)`. Returns a `(Value, Value)` tuple |
| `short_type_name::<T>()`           | Extracts the last segment from `std::any::type_name`                                     |
| `command_name_from_handler::<F>()` | Function type name → camelCase command name                                              |
| `contract_hash()`                  | Schema JSON → SHA256 hex                                                                 |
| `ts_type_from_schema()`            | JSON Schema → TS type string. Takes 2 arguments, `(schema, definitions)`                 |
| `ts_object_from_schema()`          | JSON Schema object → TS object literal                                                   |
| `command_function_name()`          | Command name → TS function name (camelCase)                                              |
| `snake_to_lower_camel()`           | snake_case → lowerCamelCase                                                              |

---

### rustra-macros (`crates/rustra-macros`)

The proc-macro crate providing the `#[command]` attribute macro and the
`register!` macro.

**Public API:**

| Item         | Kind            | Description                                                             |
| ------------ | --------------- | ----------------------------------------------------------------------- |
| `#[command]` | attribute macro | Signature verification + trait bound assert + meta constant generation  |
| `register!`  | macro           | Batch-registers multiple commands. Form: `register!(builder, fn1, fn2)` |

**`#[command]` verification rules:**

1. The function must have exactly 1 input parameter
2. The return type must have the form `Result<O>`
3. On compile success, statically asserts the `CommandInput`, `CommandOutput` trait bounds
4. Generates the command name automatically by converting the function name snake_case → lowerCamelCase

**`#[command]` attribute:** supports `#[command(name = "customName")]` to
specify the command name explicitly. When omitted, it is generated from the
function name.

**`#[command]` generated output:**

- The original function (passed through unchanged)
- `const __RUstra_meta_{fn_name}: &str` — a constant storing the command name, referenced by the `register!` macro
- `_assert_command_bounds::<I, O>()` — compile-time trait bound verification function

**`register!` behavior:**

```rust
rustra::register!(Package::builder("pkg"), add_numbers, multiply)
```

The above expands into a `.command(name, fn)` chain by reading each
function's `__RUstra_meta_*` constant.

---

## TypeScript Package Structure

Adapter packages under `packages/`. The React Native package also ships the
iOS/Android/C++ native sources reused by the TypeScript adapter and the
generator.

| Package path                         | Factory function                       | Client type         | Transport layer         |
| ------------------------------------ | -------------------------------------- | ------------------- | ----------------------- |
| `packages/node/src/index.ts`         | `createNodeEngine(transport)`          | `NodeEngineClient`  | `NodeInvokeTransport`   |
| `packages/bun/src/index.ts`          | `createBunEngine(transport)`           | `BunEngineClient`   | `BunInvokeTransport`    |
| `packages/tauri/src/index.ts`        | `createTauriEngine({ invoke })`        | `TauriEngineClient` | `TauriInvoke`           |
| `packages/react-native/src/index.ts` | generated bootstrap / low-level engine | `EngineClient`      | JSI + caller-buffer FFI |

Every client implements the `EngineClient` interface
(`invoke<T>(command, args?)`). Only the Tauri adapter wraps commands in
`rustra_dispatch` internally; the rest call the transport's `invoke` directly.

The Tauri adapter additionally exports the `RustraError` type and the
`RustraCommandError` class. `createTauriEngine` converts `rustra_dispatch`
error responses into `RustraCommandError` and throws it.

---

## Examples Structure

### calculator (`examples/calculator/`)

The core example. Contains a Rust crate + TypeScript tests + generated clients

- several host apps.

```
examples/calculator/
├── Cargo.toml          # rustra-calculator-example (rlib + staticlib)
├── src/lib.rs          # add_numbers command + calculator_package() + FFI export
├── ts/
│   ├── adapter-compat.test.ts    # 4 adapter behaviors + no host-specific imports
│   ├── generated-client.test.ts  # command helper behavior + banned import check
│   └── runtime-contract.test.ts  # host apps share generated commands + RN FFI
├── generated/          # codegen output (schema.json, types.ts, commands.ts, contract.ts)
├── apps/
│   ├── node-app.ts     # Node.js runtime app
│   └── bun-app.ts      # Bun runtime app
```

### tauri-calculator (`examples/tauri-calculator/`)

A Tauri desktop app example.

```
examples/tauri-calculator/
├── src/app.ts                # frontend, uses createTauriEngine
├── src-tauri/
│   ├── Cargo.toml            # depends on rustra (features = ["tauri"])
│   └── src/main.rs           # integrates with Tauri via rustra_support::register
```

### react-native-calculator (`examples/react-native-calculator/`)

A React Native mobile app example.

```
examples/react-native-calculator/
├── App.tsx                           # uses createReactNativeEngine
├── metro.config.js                   # shares generated/ via watchFolders
├── modules/rustra-calculator/
│   └── ios/RustraCalculatorModule.swift  # Expo Module, calls Rust via FFI
```
