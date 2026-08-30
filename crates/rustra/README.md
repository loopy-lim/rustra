English | [한국어](./README.ko.md)

# rustra

A bridge framework that generates identical TypeScript clients for React
Native / Node / Bun / Tauri and every other host from a Rust package defined
once.

## Dependencies

```toml
[dependencies]
rustra = "0.4"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

## Example

```rust
use rustra::prelude::*;

// Define input/output types
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersOutput {
    value: i64,
}

// Annotate a command handler with #[command]
#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

// Specify the command name explicitly with the name attribute
#[command(name = "customName")]
fn my_function(input: Input) -> Result<Output> { ... }

fn main() -> Result<()> {
    // Individual registration
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)  // name auto-extracted (addNumbers)
        .build();

    // Or register multiple commands at once with the register! macro
    let package = rustra::register!(
        Package::builder("example.calculator"),
        add_numbers,
        my_function
    ).build();

    // Invoke locally
    let output: AddNumbersOutput =
        package.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    assert_eq!(output.value, 5);

    // Generate the TypeScript client
    let generated = package.generate_typescript()?;
    generated.write_to_dir("generated")?;

    Ok(())
}
```

## API

### Package / PackageBuilder

| Method                              | Description                                                               |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `Package::builder(id)`              | Creates a `PackageBuilder`                                                 |
| `builder.command_fn(handler)`       | Registers a `#[command]` function. The name is auto-extracted from `type_name` |
| `builder.command(name, handler)`    | Registers a handler with an explicit name                                  |
| `builder.build()`                   | Creates a `Package`                                                        |
| `register!(builder, fn1, fn2, ...)` | Macro registering multiple `#[command]` functions at once                  |

### RustraError

| Method                           | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `RustraError::custom(code, msg)` | Creates a custom error with a stable code and message  |
| `error.code()`                   | Returns the error code                                 |
| `error.message()`                | Returns the error message                              |

`RustraError` implements `Serialize`, so it is serialized and delivered to the
TypeScript side.

### invoke

| Method                                | Description                                          |
| ------------------------------------- | ---------------------------------------------------- |
| `package.invoke::<I, O>(name, input)` | Type-safe invocation, including (de)serialization    |
| `package.invoke_json(name, params)`   | Invocation based on `serde_json::Value`              |

### TypeScript generation

| Method                          | Description                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `package.generate_typescript()` | Returns a `GeneratedPackage`                                                        |
| `generated.write_to_dir(path)`  | Writes `schema.json`, `types.ts`, `commands.ts`, `contract.ts`                     |

### Generated output

`generate_typescript()` produces the following files:

- `schema.json` — the full package schema (per-command input/output JSON Schema)
- `types.ts` — the `EngineClient` type + `RustraError` + every input/output TypeScript type
- `commands.ts` — command helper functions
- `contract.ts` — the `GENERATED_CONTRACT_HASH` constant (schema hash)

Code generation supports `$ref` resolution, `anyOf` union types, string `enum`
literals, `null` types, and type-array unions.

Example generated command helper:

```ts
import { invokeGenerated, type InvokeOptions } from '@rustra/types';

export function addNumbers(
  input: AddNumbersInput,
  options?: InvokeOptions,
): Promise<AddNumbersOutput> {
  return invokeGenerated<AddNumbersOutput>(1, 'addNumbers', input, options);
}
```

Call `configure(engine)` once at app startup, then pass only inputs and
optional cancel/timeout options to the generated functions. Engines that
support numeric command ids automatically use the fast path; older engines
fall back safely to name-based invoke.

## Caveats

- `command_fn` extracts the handler function name via `std::any::type_name`.
  Debug builds may include the full path, so if you need exact names in
  release builds, use the `#[command(name = "...")]` attribute or
  `command(name, handler)`.
- Every input type must implement `DeserializeOwned + JsonSchema`, and every
  output type `Serialize + JsonSchema`.

## prelude

```rust
pub use crate::{GeneratedPackage, Package, PackageBuilder, Result, RustraError, command};
pub use schemars::JsonSchema;
pub use serde::{Deserialize, Serialize};
```

## Tauri integration (optional feature)

Enabling the `tauri` feature provides the `tauri_support` module for direct
integration into Tauri apps:

```toml
[dependencies]
rustra = { version = "0.4", features = ["tauri"] }
```

```rust
use rustra::tauri_support::register;

let builder = register(my_package, tauri::Builder::default());
```

`register()` installs a handler that routes every command in the package
through the single `rustra_dispatch` Tauri command. On the TypeScript side,
the `@rustra/tauri` adapter routes to this endpoint automatically.
