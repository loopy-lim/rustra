English | [한국어](./function-registration.ko.md)

# Register ordinary Rust functions

This API is part of the Rust 0.11 release line. Use the manifest-aligned
[CLI and runtime versions](compatibility-matrix.md) when generating and running
the client. Local changes require separate package and native-build verification.

`PackageBuilder::function` accepts a safe synchronous Rust function or closure
with zero through twelve arguments. It does not require a Rustra macro, an
input/output wrapper struct, or a `Result` return.

```rust
use rustra::{Package, RustraError};

fn add(a: i32, b: i32) -> i32 { a + b }
fn reset() {}

enum ReadError { Missing }
fn read(id: u32) -> Result<String, ReadError> {
    if id == 7 { Ok("hello".into()) } else { Err(ReadError::Missing) }
}

let package = Package::builder("app.functions")
    .function("add", add)
    .function("reset", reset)
    .try_function("read", read, |_| RustraError::custom("read.missing", "not found"))
    .build();

assert_eq!(package.invoke_json("add", serde_json::json!([2, 3])).unwrap(), serde_json::json!(5));
```

After each change to registered functions, regenerate and typecheck:

```sh
rustra codegen            # or the scaffold script: bun run codegen
bunx tsc --noEmit         # positional signatures are compile-time checked
```

Then call the generated functions directly:

```ts
import { add, reset, read } from './generated/commands.js';

const total: number = await add(2, 3);
await reset(); // Promise<void>
const message: string = await read(7, { timeoutMs: 1000 });
```

## Arguments and returns

- Argument types need `DeserializeOwned + JsonSchema + 'static`; return types
  need `Serialize + JsonSchema + 'static`. Custom structs can use Serde and
  Schemars derives. Handler and error-mapper closures must be `Send + Sync + 'static`.
- Scalars, strings, tuples, structs and supported collections keep their return
  shape. `fn reset() {}` needs no explicit return annotation; TypeScript receives
  `undefined`. `Option<T>` produces `T | null`.
- Generated parameter names are `arg0`, `arg1`, and so on. Rust's `Fn` traits do
  not expose source parameter names. Each generated parameter has the correct
  type, and optional `InvokeOptions` always comes last.
- A function taking one tuple still takes one TypeScript tuple argument. For
  example, `fn pair(value: (i32, String))` generates `pair(arg0, options?)`, whereas
  `fn pair(a: i32, b: String)` generates `pair(arg0, arg1, options?)`.
- Low-level JSON invocation supplies a positional array, or `null` for a
  zero-argument function. A unit-valued argument occupies its position as `null`.
- Registration names are explicit. Existing `.command`, `.command_fn`,
  `#[command]`, and the metadata builder methods remain available. Use the
  existing command macro for async functions or its automatic state injection.

## Fallible functions

Use `try_function(name, handler, map_error)` to turn `Result<T, E>` into a rejected
TypeScript promise. The domain error `E` does not need a serialization or display
implementation: the mapper chooses the public `RustraError` code and message.
Use a stable error code and handle it in TypeScript with `try`/`catch`.

`function` does not automatically unwrap a `Result`: if serializable, that value
is ordinary return data. Explicit registration keeps type inference predictable.

## Binary execution

Supported argument tuples and return values use typed binary codecs. Fixed
tuples carry their values in order without a tuple-length prefix. Scalar tuples
use a generated cursor writer and reusable request storage. On Rust's successful
scalar caller-buffer path, input decoding and output serialization avoid a JSON
tree and a heap response allocation.

This is not an allocation-free guarantee for the whole application. Owned
strings and collections may allocate, JavaScript may copy an exact-size request
buffer, and a small caller buffer requires an allocated response. Unsupported
schemas retain the existing complex or JSON fallback.

Function commands currently use the generated JavaScript binary codec on React
Native when native static capabilities decline the root shape. They do not use
the native scalar raw/positional shortcut. No React Native speed or device-runtime
claim follows from a Rust microbenchmark.

## Verification

```sh
bun run test:functions
cargo test -p rustra --test function_allocations
cargo bench -p rustra --bench function_dispatch
```

The integration test generates a client from a real Rust fixture, type-checks
both public emitters, and sends encoded requests to the Rust fixture process.
It covers static and live-schema routing, native capability fallback, errors,
unit and non-finite returns, and caller-buffer fallback.
