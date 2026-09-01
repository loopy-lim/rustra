English | [한국어](./testing.ko.md)

# Test Structure and Execution Guide

Internal documentation for project contributors. Summarizes the test layer
hierarchy, the role of each file, the Bun script chain, and the execution
commands.

---

## Test Layer Hierarchy

```
cargo test (Rust unit tests)
  │
  ▼
TS tests (generated-client + adapter-compat + runtime-contract)
  │
  ▼
Adapter tests (verify each host transport behavior)
  │
  ▼
Runtime tests (Node / Bun / Tauri actual execution)
  │
  ▼
Compat tests (full-pipeline integration)
```

Lower layers are prerequisites for the layers above, so they must pass in
order from the top.

---

## Rust Tests

### File: `crates/rustra/tests/public_authoring_api_tests.rs`

10 tests. Verifies rustra's public authoring API.

| Test function                                                   | What it verifies                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_builds_package_without_touching_raw_engine_types`         | `Package::builder().command().build()` + `invoke()` basic flow. Confirms the result value is 42                                                                                                                        |
| `user_can_register_command_without_writing_command_name_string` | Automatic name extraction with `command_fn()`. Confirms the generated `commands.ts` contains the function name and command name                                                                                        |
| `register_macro_uses_macro_derived_name`                        | Registers a command with the `register!` macro. Confirms the name is auto-extracted from the `__RUstra_meta_*` constant and invoked correctly                                                                          |
| `package_generates_host_neutral_typescript_client`              | Confirms the `generate_typescript()` result contains the `AddNumbersInput` type, the `addNumbers` function, and `invoke<AddNumbersOutput>`. Confirms `EngineRequest`, `Attachment`, `node:`, `react-native` are absent |
| `generated_package_can_be_written_to_a_directory`               | Confirms the file-writing pair: `write_schema_to_dir()` produces only `schema.json` (honoring `RUSTRA_SCHEMA_OUT`); `write_to_dir()` produces the 4 files `schema.json`, `types.ts`, `commands.ts`, `contract.ts`      |
| `unknown_command_uses_package_level_error`                      | Confirms the `RustraError` code is `"command.not_found"` when calling an unregistered command. Uses the `error.code()` getter                                                                                          |
| `ts_generator_handles_optional_fields`                          | Confirms `Option<i64>`, `Option<String>` fields are generated as `age?: number \| null`, `label?: string \| null`                                                                                                      |
| `ts_generator_handles_enums`                                    | Confirms the enum type is generated as a `Status` reference type + `'Active' \| 'Inactive'` union                                                                                                                      |
| `ts_generator_handles_vec_and_optional_struct`                  | Confirms `Vec<String>` → `string[]` and `Option<Item>` → `Item \| null` generation                                                                                                                                     |
| `command_macro_rejects_wrong_signature`                         | Verifies via compile check that the `#[command]` macro rejects wrong signatures. Valid signatures pass; a function without parameters and a non-`Result` return fail                                                   |

### File: `examples/calculator/tests/example_contract.rs`

1 integration test. Verifies the calculator example's build output end to end.

| Test function                                  | What it verifies                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculator_example_runs_and_generates_client` | Runs the `rustra-calculator-example` binary → confirms stdout contains `2 + 3 = 5`. Confirms `generated/commands.ts` contains the `addNumbers` function and `engine.invoke<AddNumbersOutput>('addNumbers')`, and that `EngineRequest`/`Attachment` are absent |

This test executes the built binary directly through the
`CARGO_BIN_EXE_rustra-calculator-example` environment variable when
`cargo test` runs, so it verifies the entire code generation pipeline.

### Run

```bash
cargo test
```

### Complex binary codec

`crates/rustra/src/complex_codec.rs` and `crates/rustra/tests/rkyv_v2_wire.rs`
verify the schema-driven codec's map key ordering, Option, Set, data enum
variant keys, and malformed/trailing payload boundaries. The TypeScript
counterpart fixture lives in `packages/types/src/complex-codec.test.ts`, and
the golden data-enum wire must be identical across both implementations.

```bash
cargo test -p rustra --test rkyv_v2_wire oneof_command_uses_complex_binary_wire
bun test packages/types/src/complex-codec.test.ts
bun run bench:complex
```

---

## TypeScript Tests

### File: `examples/calculator/ts/generated-client.test.ts`

2 tests. Verifies the generated TS client's behavior.

| Test                                                                         | What it verifies                                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated command helper calls the host EngineClient invoke contract`       | After `configure(engine)`, calling `addNumbers(input)` passes the correct command name and args through the global invoke to the engine                     |
| `generated client stays host neutral for Node, Bun, Tauri, and React Native` | Confirms `commands.ts` + `types.ts` contain none of `node:`, `bun:`, `@tauri-apps`, `react-native`, `@expo/`, `expo-modules`, `EngineRequest`, `Attachment` |

### File: `examples/calculator/ts/adapter-compat.test.ts`

6 tests. Verifies the behavior and integrity of the 4 adapter packages.

| Test                                                                          | What it verifies                                                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `node adapter forwards generated commands to injected Node transport`         | `createNodeEngine` calls the transport's invoke correctly                                                 |
| `bun adapter forwards generated commands to injected Bun transport`           | `createBunEngine` calls the transport's invoke correctly                                                  |
| `tauri adapter forwards generated commands to injected Tauri invoke`          | `createTauriEngine` wraps in `rustra_dispatch` and calls invoke. Confirms `RustraCommandError` conversion |
| `react native adapter forwards generated commands to injected native module`  | `createReactNativeEngine` calls the native module's invoke correctly                                      |
| `adapter packages keep host-specific imports out of the shared contract path` | Confirms the 4 adapter sources contain none of `@tauri-apps`, `react-native`, `@expo/`, `expo-modules`    |

Common pattern: `createRecordingTransport()` records the calls and the test
checks that the `addNumbers` generated command reaches the transport with the
correct parameters.

### File: `examples/calculator/ts/runtime-contract.test.ts`

2 tests. Verifies that host apps use the same generated commands and that the
RN FFI wiring is correct.

| Test                                                                      | What it verifies                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host apps share generated commands and differ only by adapter transport` | The Node, Bun, Tauri, and RN apps all import `../generated/commands.js`. Each uses `createNodeEngine`, `createBunEngine`, `createTauriEngine`, `createReactNativeEngine`. The Tauri `main.rs` calls `invoke` directly from Rust and does not perform the addition in JS |
| `react native runtime fixture exposes a native Rust-backed invoke module` | The Swift module registers as `RustraCalculator`, exposes the `invokeRaw` async function, and calls the `rustra_calculator_invoke` / `rustra_calculator_free_string` FFI functions. Confirms the FFI exports in the Rust lib.rs                                         |

### Run

```bash
# Node.js test runner
bun run test:ts:node

# Bun test runner
bun run test:ts:bun
```

---

## Bun Script Chain

The test script chain defined in `package.json`:

```
test:ts:node        → tsc --noEmit + node --test
test:ts:bun         → bun test
test:runtime:node   → cargo build + tsc + node node-app.js
test:runtime:bun    → cargo build + bun bun-app.ts
test:adapter:tauri  → bun tauri-app.ts
test:adapter:react-native → bun react-native-app.ts
test:app:react-native → cd react-native-calculator && bun run typecheck
test:runtime:tauri  → cd tauri-calculator && bun run build && bun run smoke
test:adapters       → test:adapter:tauri + test:adapter:react-native + test:app:react-native
test:runtime        → test:runtime:node + test:runtime:bun + test:runtime:tauri
test:compat         → test:adapters + test:runtime
```

### Tauri Smoke Test Procedure

`test:runtime:tauri` works in the following order:

1. `cargo build` — builds the Rust backend (rustra `tauri` feature enabled)
2. `bun run build` — builds the Tauri app (produces the binary)
3. `bun run smoke` — runs the app → JS call in the WebView (`rustra_dispatch`) → checks the result → exits

This verifies end to end, on a real Tauri runtime, the path
`createTauriEngine` → `addNumbers` → `rustra_dispatch` → Rust `invoke_json`.

---

## React Native Test Status

| Layer                           | Status | Notes                                                                    |
| ------------------------------- | ------ | ------------------------------------------------------------------------ |
| adapter-compat.test.ts          | PASS   | Confirms `createReactNativeEngine` behavior                              |
| runtime-contract.test.ts        | PASS   | Verifies the Swift module + FFI export structure                         |
| test:adapter:react-native       | PASS   | Runs `bun react-native-app.ts`                                           |
| test:app:react-native           | PASS   | TypeScript typecheck passes                                              |
| Android release real-device run | PASS   | Confirmed complex/channel/resource/benchmark receipts on `TB710FU` arm64 |
| iOS generic device build        | PASS   | `iphoneos` Debug link succeeded; device runtime not yet run              |
| iOS Simulator run               | PASS   | iPhone 17 Simulator Release embedded-bundle runtime receipt confirmed    |

**Boundary:** package/build success does not substitute for runtime. Android
is verified up to real-device runtime, and iOS up to the generic device build
and the iPhone 17 Simulator runtime. iOS physical-device execution is separate
evidence.

---

## Command Reference

### Running the full suite

```bash
# Rust unit tests
cargo test

# TS tests (Node.js)
bun run test:ts:node

# TS tests (Bun)
bun run test:ts:bun

# Full compatibility suite
bun run test:compat
```

### Running individual layers

```bash
# Adapter tests only
bun run test:adapters

# Runtime tests only
bun run test:runtime

# Specific host runtime
bun run test:runtime:node
bun run test:runtime:bun
bun run test:runtime:tauri

# Specific adapter
bun run test:adapter:tauri
bun run test:adapter:react-native
bun run test:app:react-native
```

### Regenerating the generated client

To refresh the generated TS client after Rust code changes:

```bash
cargo build
# generated automatically into examples/calculator/generated/
```
