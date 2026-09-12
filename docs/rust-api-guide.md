English | [한국어](./rust-api-guide.ko.md)

# rustra-bridge Rust API Guide

## 1. Overview

rustra-bridge is a bridge framework that automatically generates a TypeScript client — working from Node / Bun / Tauri / React Native alike — once you define commands in Rust.

```text
Rust #[command] definition → automatic TypeScript client generation → execution via each platform adapter
```

There are three core components:

| Component          | Role                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `#[command]`       | Attribute macro that turns a function into a bridge command                 |
| `#[bridge_type]`   | Automatically adds the required derives and serde settings to structs/enums |
| `rustra::build!()` | Creates the package builder and registers multiple commands at once         |

---

## 2. The `#[command]` Macro

An attribute macro that converts a function into a rustra-bridge command. Use it as `#[command]` or `#[command(name = "customName")]`.

### 2-1. Struct Parameter Mode (the only input form)

A `#[command]` function must take **exactly one Input struct parameter**. Scalar
multi-parameters (`fn add(a: i64, b: i64)`) are not supported — they fail to compile:

```text
#[command] supports at most one input data parameter
```

If you need multiple values, define an Input struct:

```rust
use rustra::prelude::*;

#[bridge_type]
struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    pub value: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}
```

`#[bridge_type]` automatically adds the `Serialize`/`Deserialize`/`JsonSchema` derives and
`#[serde(rename_all = "camelCase")]`, so the TypeScript side sees
`{ a: number, b: number }`.

### 2-2. Zero-Parameter Commands

Commands that need no input are defined with a `()` input:

```rust
#[command]
fn ping() -> Result<()> {
    Ok(())
}
```

A `()` input generates a parameterless function in TypeScript
(`invoke('ping', undefined)`).

### 2-3. Return Types

The return type **must be `Result<O>`**. Bare returns (`-> i64`) and omitted unit returns
are compile errors:

```text
#[command] function must have an explicit return type Result<O>
```

```rust
// ✅ correct return
#[command]
fn divide(input: DivisionInput) -> Result<DivisionOutput> {
    if input.divisor == 0 {
        return Err(RustraError::invalid_args("division by zero"));
    }
    Ok(DivisionOutput {
        quotient: input.dividend / input.divisor,
        remainder: input.dividend % input.divisor,
    })
}
```

Commands with no value use `Result<()>`. A `()` output generates `Promise<void>` in
TypeScript.

### 2-4. Command Name Rules

Function names are converted to lowerCamelCase automatically:

| Function name          | Command name                                             |
| ---------------------- | -------------------------------------------------------- |
| `add_numbers`          | `addNumbers`                                             |
| `find_user`            | `findUser`                                               |
| `do_something_command` | `doSomething` (`_command` suffix stripped automatically) |

To specify one directly, use the `name` attribute:

```rust
#[command(name = "calc.add")]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    // registers as "calc.add" instead of "addNumbers"
    Ok(AddNumbersOutput { value: input.a + input.b })
}
```

### 2-5. Compile-Time Validation

The `#[command]` macro validates the following at compile time:

**Parameter count validation** — there can be at most one data parameter. Two or more is
a compile error (zero is allowed as a `()` input — see §2-2):

```text
#[command] supports at most one input data parameter
```

**Trait bound validation** — the I/O types must satisfy the required traits:

- Input type: `DeserializeOwned + JsonSchema`
- Output type: `Serialize + JsonSchema`

Currently, an unsatisfied trait bound produces the standard Rust E0277 diagnostic:

```text
error[E0277]: the trait bound `MyType: CommandInput` is not satisfied
   --> src/main.rs:5:1
    |
5   | #[command]
    | ^^^^^^^^^ the trait `CommandInput` is not implemented for `MyType`
    |
note: required for `MyType` to implement `CommandInput`
    (unsatisfied trait bound introduced by the blanket `impl<T> CommandInput for T`)
```

Roadmap: a `#[diagnostic::on_unimplemented]` attribute on `CommandInput`/`CommandOutput`
may one day turn this into a friendlier message (e.g. suggesting `#[bridge_type]`), but
it is not implemented — always read the E0277 text above.

---

### 2-6. Async Commands and the Executor

`#[command]` accepts `async fn`. An async command registers, schema-generates, and
dispatches exactly like a synchronous one:

```rust
#[command]
async fn find_user(input: UserQuery) -> Result<User> {
    let user = slow_lookup(&input.id).await;
    Ok(user)
}
```

Async syntax support is **not** a general-purpose async runtime. The generated wrapper
drives the future on the calling thread with a park-based executor (the waker is
`Thread::unpark`; see `crates/rustra/src/executor.rs`). Four consequences matter to
host integrators:

1. **The executor parks the current thread.** Inside a multithreaded host runtime
   (e.g. tokio) a parked worker thread is a starved worker — route async command
   dispatch through `spawn_blocking` (or an equivalent dedicated pool), or wait for a
   fully async dispatch path. On the FFI async path the handler runs on rustra's fixed
   worker pool (below), so one slow async command parks one of the two workers.
2. **`State<T>` is thread-local and invisible to spawned tasks.** State injection
   travels through a thread-local context, valid only on the thread the dispatch
   started on; a task the handler moves to another worker observes `None`. Capture
   what you need (clone the `Arc`) before spawning.
3. **FFI async calls run on a fixed pool — 2 workers, queue depth 256.** The pool is
   fail-fast: a full queue rejects immediately with `invoke.backpressure` instead of
   hanging (`crates/rustra/src/ffi_pool.rs`). Treat it as backpressure and retry after
   drain. The constants are fixed, not configurable.
4. **No I/O reactor or timer driver is provided.** Any future that completes
   independent of a runtime context works — wakeups from any thread unpark the
   blocked one. Futures that require a reactor or timer (tokio resources,
   `tokio::time`) need the host's runtime entered around the dispatch; rustra creates
   none.

Executor injection (plugging in your own `block_on`) is not supported. If you feel the
need, measure first — it is deliberately out of scope.

---

## 3. The `#[bridge_type]` Attribute

Adds the derives and serde settings a struct or enum needs in one line.

```rust
#[bridge_type]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}
```

The above is equivalent to:

```rust
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}
```

What is added automatically:

- `#[derive(Debug, Serialize, Deserialize, JsonSchema)]`
- `#[serde(rename_all = "camelCase")]`

### Overrides

`#[bridge_type]` always adds `#[serde(rename_all = "camelCase")]`. If you need a
different naming convention, attach the derives directly without `#[bridge_type]`:

```rust
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
struct RawQuery {
    pub field_name: String, // kept as "field_name" in JSON
}
```

(There is no override attribute of the form `#[bridge(rename_all = "...")]`.)

### Works on Enums Too

```rust
#[bridge_type]
enum Status {
    Active,
    Inactive,
}
```

This generates a union type in TypeScript:

```typescript
export type Status = 'Active' | 'Inactive';
```

Data-carrying enums are also supported:

```rust
#[bridge_type]
enum Shape {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
}
```

---

## 4. The `rustra::build!()` Macro

A macro that creates the package builder and registers `#[command]` functions all at once.

### Basic Usage

```rust
// register + build
let pkg = rustra::build!("examples.calculator", add_numbers, multiply).done();

// TypeScript generation happens via Package's generate_typescript
pkg.generate_typescript()?.write_schema_to_dir("generated")?;
```

### What the Macro Expands To

Calling `rustra::build!("examples.calculator", add_numbers)` expands to:

```rust
rustra::Package::builder("examples.calculator")
    .command(__RUstra_meta_add_numbers, __rustra_add_numbers_handler)
```

For each `#[command]` function, the macro generates:

| Generated item    | Naming rule                  | Role                                                         |
| ----------------- | ---------------------------- | ------------------------------------------------------------ |
| Metadata constant | `__RUstra_meta_<fn_name>`    | A `&str` constant holding the command name                   |
| Handler function  | `__rustra_<fn_name>_handler` | A wrapper performing input type conversion and Ok() wrapping |
| Trait bound check | `_check_command_bounds`      | Verifies the I/O types satisfy the required traits           |

---

## 5. PackageBuilder Methods

`PackageBuilder` is the builder that registers commands incrementally. Create it with
`Package::builder(id)` (or the `rustra::build!` macro calls it internally).

### `.command_fn(handler)`

Registers a `#[command]` function with name inference. It strips the `_command` suffix
from the function name, converts it to lowerCamelCase, and uses the result as the
command name.

```rust
use rustra::register;

let pkg = register!(Package::builder("example.calculator"), add_numbers).build();
```

The `register!` macro wires `#[command]` functions through `.command_fn()` for you.

### `.command(name, handler)`

Registers with an explicitly given name.

```rust
let pkg = Package::builder("example.calculator")
    .command("addNumbers", my_handler)
    .build();
```

If a command with the same name is already registered, it panics.

### `.buffer_command_fn(handler)` / `.buffer_command(name, handler)`

Explicitly registers the React Native `Uint8Array`/`ArrayBuffer` dedicated ownership path
for commands whose input and output are each exactly one required `Vec<u8>` field. The
ordinary postcard/JSON command contracts are kept as well, so other hosts and the legacy
native module keep working through the existing paths.

```rust
#[derive(Serialize, Deserialize, JsonSchema)]
struct Bytes {
    #[serde(with = "rustra::byte_buffer")]
    #[schemars(with = "Vec<u8>")]
    data: Vec<u8>,
}

impl BufferCommandInput for Bytes {
    fn from_buffer(data: Vec<u8>) -> Self { Self { data } }
}

impl BufferCommandOutput for Bytes {
    fn into_buffer(self) -> Vec<u8> { self.data }
}

#[command]
fn echo_bytes(input: Bytes) -> Result<Bytes> { Ok(input) }

let pkg = Package::builder("example.bytes")
    .buffer_command_fn(echo_bytes)
    .build();
```

Contract essentials (what you rely on as a user):

- **Schema condition** — the command's input and output must each be exactly one
  required `uint8` array (`Vec<u8>`) field; anything else panics at the `build()`
  stage so the direct ABI is never advertised incorrectly.
- **Memory ownership** — input JS memory is borrowed only for the duration of the
  synchronous call; the Rust output allocation is copied into a JS-owned
  `ArrayBuffer` and freed by the JSI `ArrayBuffer` at end of life (no manual
  pointer management on the JS side).
- The ordinary postcard/JSON command contracts are kept as well — other hosts and
  the legacy native module keep working through the existing paths.

Design rationale and the full C++/JSI boundary discussion:
[direct byte-buffer design](plans/2026-08-24-rn-byte-buffer-native-path.md).

### Other Builder Methods

| Method                                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.require_capability(name, cap)`        | Requires a capability for a command (deny-by-default Runtime Authority)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.platform_command::<I, O>(name, ps)`   | Declares a platform-specific command (registered on **all** platforms)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.platform_command_impl(name, handler)` | Injects the real handler on a platform the command supports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.buffer_command_fn(handler)`           | Registers the name-inferred single `Vec<u8>` direct path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.buffer_command(name, handler)`        | Registers the explicitly named single `Vec<u8>` direct path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.alias_command_id(command, legacy_id)` | Registers a legacy cmd_id alias (backward-compatible dispatch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `.event::<T>(name)`                     | Declares an event contract — payload type `T` for `name`; recorded in schema.json `events` and rendered to `generated/events.ts` (see the [events and channels guide](events-and-channels.md))                                                                                                                                                                                                                                                                                                                                              |
| `.event_capacity(capacity)`             | Sets the event bus ring buffer capacity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.schema_version(version)`              | Declares the schema negotiation version (T2, OTA)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `.manage(state)`                        | Registers shared state (accessed via `State<T>` parameters and `Package::state::<T>()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.command_errors(name, variants)`       | Declares a command's domain error codes (`&[CommandErrorVariant]`; the builder form of `#[command(error(...))]`) — recorded in schema.json `errors` and rendered to `generated/errors.ts` (see [Command-scoped Error Declarations](#command-scoped-error-declarations-typed-errors))                                                                                                                                                                                                                                                        |
| `.command_devices(name, devices)`       | Declares the device capabilities a command presumes (`&[DeviceCapability]`; the builder form of `#[command(device(camera, bluetooth))]`) — recorded in schema.json `devices` plus the top-level `deviceCapabilities` catalog and rendered to `generated/devices.ts`; no runtime gating. Panics on an unregistered command, an empty list, duplicate tokens, and — release builds only — catalog-outside tokens (debug builds warn and accept; see [dev-tier.md](dev-tier.md) and the [platform permissions guide](platform-permissions.md)) |

### State injection: `State<T>` parameters

A `#[command]` function may take additional `State<T>` parameters besides the single
input struct. Register the state with `.manage(state)`; the macro injects it into the
handler via `rustra::get_state::<T>()`. Calling a command whose `State<T>` was never
managed fails with the `internal` error `State<T> not managed in package`.

```rust
use rustra::prelude::*;

#[bridge_type]
struct QueryInput { user_id: String }

#[bridge_type]
struct QueryOutput { display_name: String }

struct Db { /* your connection pool, caches, ... */ }

#[command]
fn query_user(input: QueryInput, db: State<Db>) -> Result<QueryOutput> {
    let _db: &Db = &db.0; // State<T>(pub Arc<T>) — cheap shared handle
    Ok(QueryOutput { display_name: input.user_id })
}
```

```rust
let pkg = Package::builder("app.users")
    .command_fn(query_user)
    .manage(Db { /* ... */ })
    .build();
```

`State<T>` parameters are never part of the wire contract — they do not appear in
schema.json, so adding or removing them is not a breaking change.

### Platform-specific commands (`.platform_command` / `.platform_command_impl`)

Platform-specific commands (Win32/AppKit calls, native window handles, ...) stay
contract-stable across platforms. `platform_command` registers the command —
command_id, schema.json and the contract hash — on **every** platform with a stub
that returns `platform.unavailable`; `platform_command_impl` replaces the stub with
the real handler on the platforms you support:

```rust
use rustra::platform::Platform;

let builder = Package::builder("app.native")
    .platform_command::<(), NativeWindowInfo>(
        "nativeWindowInfo",
        &[Platform::Windows, Platform::Macos],
    );
// Guard the real implementation so it only compiles where it exists.
#[cfg(any(target_os = "windows", target_os = "macos"))]
let builder = builder.platform_command_impl("nativeWindowInfo", native_window_info_impl);
let pkg = builder.build();
```

Contract:

- The command set (ids, schema, hash) is identical on every platform — by-id
  dispatch and cross-validation never shift.
- Calling a stub on an unsupported platform returns `platform.unavailable`
  (non-retryable) — distinct from `command.not_found` ("not in the contract at
  all").
- `build()` panics if the current platform is declared but `platform_command_impl`
  was never called (a silent stub on a supported platform is a wiring bug), and
  `platform_command_impl` panics if the current platform is _not_ declared
  (misplaced `#[cfg]`).
- `I`/`O` types must be identical in declaration and impl — the schema may not
  differ per platform.
- schema.json records `"platforms": [...]` on such commands; unsupported callers
  can branch before invoking.

Opaque native resources (Win32 `HANDLE`, `NSView*`, ...) follow the existing
`ResourceHandle` pattern: the host stores the resource in the Rust-side resource
table (`ResourceHandle`, see the channels module) and JS only ever passes the
`u32` id. Never expose raw 64-bit pointers to JS.

### `.build()` / `.done()`

Builds all registered commands into an immutable `Package`. `.done()` is an alias of
`.build()` (the `rustra::build!` expansion finishes with `.done()`).

```rust
let pkg = Package::builder("example.calculator")
    .command_fn(my_handler)
    .build();
```

---

## 6. Package Methods

`Package` is an immutable type representing a registered set of commands. Internally
`Arc`-based, so it can be cloned cheaply.

### `.invoke::<I, O>(name, input)`

The type-safe command invocation.

```rust
let output: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
println!("Result: {}", output.value);
```

Generic parameters:

- `I: Serialize` — the input type
- `O: DeserializeOwned` — the output type

### `.invoke_json(name, params)`

A non-generic invocation that passes a JSON `Value` directly. Suited to JSON-based routing.

```rust
use serde_json::json;

let result: Value = pkg.invoke_json("addNumbers", json!({ "a": 2, "b": 3 }))?;
```

### `.generate_typescript()`

Generates the code generation result from all registered commands — the
contract probe output. Publishing `schema.json` (`write_schema_to_dir`) is
the Rust side's job; the TS CLI renders the surfaces from it.

```rust
let generated = pkg.generate_typescript()?;
```

---

## 7. GeneratedPackage

The struct holding the TypeScript code generation result.

| Field           | Output file   | Content                                            |
| --------------- | ------------- | -------------------------------------------------- |
| `schema_json`   | `schema.json` | The full command schema (JSON)                     |
| `types_ts`      | `types.ts`    | TypeScript type definitions                        |
| `commands_ts`   | `commands.ts` | TypeScript command helper functions                |
| `contract_hash` | `contract.ts` | The schema's SHA-256 hash (integrity verification) |

### `.write_schema_to_dir(dir)`

Writes `schema.json` — the contract probe output — into the given directory,
creating it if it does not exist. `rustra codegen` then renders every surface
(types, commands, contract, codecs, host entries) from this single file.

```rust
let generated = pkg.generate_typescript()?;
generated.write_schema_to_dir("generated")?;
```

The pipeline:

```text
generated/schema.json   # published by the Rust probe
        │ rustra codegen --config rustra.json
        ▼
generated/
  schema.json      # full command schema
  types.ts         # TypeScript type definitions
  commands.ts      # TypeScript command helper functions
  contract.ts      # GENERATED_CONTRACT_HASH constant
  ...              # codecs, positional facade, host entries
```

> `.write_schema_to_dir(dir)` publishes only `schema.json`. The TS surfaces
> (`types.ts` etc.) are owned by `rustra codegen` — never regenerate them from Rust.
> The old `.write_to_dir(dir)` dual pass is deprecated for this reason.

---

## 8. Error Handling

### RustraError

Every error carries `code` and `message` fields.

```rust
use rustra::prelude::*;

#[bridge_type]
struct DivideInput { a: i64, b: i64 }

#[bridge_type]
struct DivideOutput { value: i64 }

#[command(error("math.divide_by_zero"))]
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("math.divide_by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
}
```

### Command-scoped Error Declarations (typed errors)

String-comparing `err.code` in TypeScript works, but typos in codes compile fine and
fail silently. Declare the domain codes a command may return, and `rustra codegen`
turns them into a per-command literal union plus a type guard.

Declare with the attribute (recommended — the declaration lives next to the handler):

```rust
#[command(error("math.divide_by_zero"))]
fn divide(input: DivideInput) -> Result<DivideOutput> { /* … */ }
```

or with the builder chain, where you can also attach metadata (JSDoc/`retryable` —
documentation only, it does not change wire semantics):

```rust
use rustra::CommandErrorVariant;

let package = Package::builder("example.math")
    .command_errors(
        "divide",
        &[CommandErrorVariant::new("math.divide_by_zero")
            .describe("raised when the divisor is zero")],
    )
    // …register commands and build…
```

After `rustra codegen`, a generated `errors.ts` appears whenever at least one command
declares errors. On the TypeScript side, catch and narrow instead of string-matching:

```ts
import { isDivideError, DivideErrorCode } from './generated/errors.js';

try {
  await divide({ a: 10, b: 0 });
} catch (e) {
  if (isDivideError(e) && e.code === DivideErrorCode.MathDivideByZero) {
    // e is DivideError here — `e.code === 'math.divideBy_zero'` would not compile.
  }
}
```

Rules:

- Codes must match `^[a-z][a-z0-9_.]*$` — the builder panics otherwise (the JSON
  fallback path could not split such a code back out of `Display` output).
- Declarations cover the command's **domain** codes only. Framework codes
  (`cancelled`, `transport.timeout`, `command.invalid_args`, …) can occur on any
  command and stay in the shared `RustraErrorCode` table — compare those directly.
- A declaration is a contract document, not runtime validation: handlers may still
  return undeclared codes, and the guard returns `false` for them (the runtime is an
  open contract; the union is closed). Adding declarations changes schema.json and
  therefore the contract hash — intended contract evolution, caught by
  `rustra diff`.
- The wire error frame and `RustraCommandError` are unchanged — see
  [wire-format.md](./wire-format.md).

### Error Code Classification

| Code                   | Factory method                         | Meaning                                   |
| ---------------------- | -------------------------------------- | ----------------------------------------- |
| `command.not_found`    | `RustraError::command_not_found(name)` | Invoking an unregistered command          |
| `command.invalid_args` | `RustraError::invalid_args(error)`     | Input argument deserialization failure    |
| `capability.denied`    | `RustraError::capability_denied(d)`    | Capability not granted                    |
| `transport.error`      | `RustraError::transport(error)`        | Transport/network error — **retryable**   |
| `transport.timeout`    | `RustraError::timeout(error)`          | Timeout — **retryable**                   |
| `internal`             | `RustraError::internal(error)`         | Internal error (serialization, I/O, etc.) |
| (custom)               | `RustraError::custom(code, message)`   | User-defined error                        |

### Retryability (retryable)

Errors created via `transport.error`/`transport.timeout` carry `retryable: true`. Any
error can take the `.retryable()` builder, and it is queried with `is_retryable()`:

```rust
let err = RustraError::custom("db.locked", "retry later").retryable();
assert!(err.is_retryable());
```

The TypeScript-side `RustraCommandError` exposes the same value as the `.retryable`
field (on JSON paths without the flag on the wire, it is inferred from the
`transport.*` codes). The JS-side `invoke` `options.timeoutMs` rejects with this
`transport.timeout` (retryable) on expiry — the JS-side escape hatch from a hung native.

### JS call semantics: signal, timeoutMs, invokeBatch

Every generated helper accepts `InvokeOptions` as its last parameter, and
`@rustra/types` exports the same options for raw `invoke`/`invokeBatch`:

```ts
import { invokeBatch } from '@rustra/types';
import { addNumbers, slowCompute } from './generated/commands.js';

// cancellation — AbortSignal rejects the promise immediately (`cancelled`); on
// hosts without invokeCancel propagation this is a shallow cancel
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
await addNumbers({ a: 20, b: 22 }, { signal: controller.signal });

// timeout — rejects with `transport.timeout` (retryable) after the deadline
await slowCompute({ workload: 'heavy' }, { timeoutMs: 500 });

// batch — one array, order preserved; entries without a signal can take a
// single native crossing on the Frame engine
const [sum, echo] = await invokeBatch([
  { command: 'addNumbers', args: { a: 20, b: 22 } },
  { command: 'echo', args: { message: 'hi' }, options: { timeoutMs: 1000 } },
]);
```

Per-adapter behavior of each option (which cancellation is shallow, which batch
takes a single crossing) is the [compatibility matrix](compatibility-matrix.md).

### Timeout, Cancellation, and Retry Semantics (what a flag does and does not mean)

`retryable: true` means the transport observed a _retryable class of failure_. It does
**not** mean the command is safe to re-run.

**Not receiving a response ≠ the command not running.** Shallow cancellation
(`options.signal` on adapters without `invokeCancel`) and `options.timeoutMs` both
abandon the JS promise while the Rust side keeps going. After either fires, the
command may still be running — or already completed, its result discarded. Re-running
a non-idempotent command on a retryable flag can double-charge, double-send, or
double-insert. Before retrying on general transport failures, check the effect:

```ts
import { withRetry } from '@rustra/types';

// Safe: the command is a read — retrying cannot duplicate an effect.
const user = await withRetry((attempt) => invoke('getUser', { id }), {
  retries: 2,
  baseDelayMs: 100,
});

// Unsafe without a guard: a non-idempotent command must not retry blindly.
// Narrow the retry decision with retryIf — it fully replaces the default
// isRetryableCode judgment (transport.error / transport.timeout / cancelled):
await withRetry((attempt) => invoke('chargeCard', { id, amountCents: 500 }), {
  retryIf: (err) => err.code === 'transport.error', // connection-level only
});
// For a write whose success is unobservable, don't guess — reconcile:
//   retry only after a status re-query proves the write did not land.
```

Batch rejection is not a rollback. `invokeBatch` rejects the overall promise when an
entry fails, but dispatched entries have run and their effects stand — there is no
all-or-nothing transaction. The per-entry fallback starts every entry concurrently,
and the RN single-crossing batch stops at the first failing entry; the Tauri wire
batch runs all entries and rejects afterwards. `invokeBatch` itself has no settled
form — for partial-outcome observation use `invokeBatchSettled` (`@rustra/types`): it
always runs entries sequentially per-entry (never the atomic wire batch), so a failed
entry and everything after it are distinguishable — each entry settles as
`{ status: 'fulfilled', value }`, `{ status: 'rejected', reason }`, or
`{ status: 'unexecuted' }`, where `unexecuted` means the entry was never dispatched.
Per-entry `signal`/`timeoutMs` apply exactly as with a single `invoke`.

### Error Methods

```rust
let err = RustraError::custom("auth.unauthorized", "invalid token");
assert_eq!(err.code(), "auth.unauthorized");
assert_eq!(err.message(), "invalid token");
```

### The Result Type

`rustra::prelude::Result<T>` is an alias of `std::result::Result<T, RustraError>`.

```rust
use rustra::prelude::*;

fn my_function() -> Result<String> {
    Ok("hello".into())
}
```

### Automatic std::io::Error Conversion

`From<std::io::Error>` is implemented, so errors propagate naturally with the `?` operator:

```rust
fn write_output() -> Result<()> {
    std::fs::write("output.txt", "hello")?; // io::Error → RustraError(internal)
    Ok(())
}
```

---

## 9. TypeScript Generation Rules

### Type Mapping

| Rust type                    | TypeScript type                                               |
| ---------------------------- | ------------------------------------------------------------- |
| `i64`, `u64`                 | `number \| bigint` (values outside ±2^53 restore as `bigint`) |
| `i32`, `u32`, `f64`, etc.    | `number`                                                      |
| `String`                     | `string`                                                      |
| `bool`                       | `boolean`                                                     |
| `Option<T>`                  | `T \| null` (struct fields use `?:`)                          |
| `Vec<T>`                     | `T[]`                                                         |
| `Vec<Vec<T>>`                | `T[][]` (nesting supported)                                   |
| `HashMap<String, V>`         | `Record<string, V>`                                           |
| `BTreeSet<T>` / `HashSet<T>` | `Set<T>` (`uniqueItems` mapping)                              |
| `(A, B, C)`                  | `[A, B, C]` (tuple)                                           |
| Simple `enum`                | `'Variant1' \| 'Variant2'`                                    |
| Data-carrying `enum`         | Object union type                                             |

### User-Defined Generic Types

Generic structs like `Wrapper<T> { value: T }` work at the **concrete instance
level**: schemars 0.8 generates a monomorphized schema per instantiation
(`Wrapper<String>` → schema name `Wrapper_for_String`), and rustra pins the
command's `inputType`/`outputType` to that exact schemars name. The result is a
valid TypeScript identifier that matches the schema `title` and the
`definitions` keys, so validation, TS/C++ rendering, and codec generation all
agree without special handling.

```rust
#[bridge_type]
struct Wrapper<T> { value: T }

#[command]
fn echo_wrapped(input: Wrapper<String>) -> Result<Wrapper<String>> {
    Ok(Wrapper { value: input.value })
}
```

```typescript
export type Wrapper_for_String = { value: string };
```

Notes:

- `Option<T>`, `Vec<T>`, `Result<T, E>` (command returns), and `Box<T>` are
  standard-library generics and need nothing special — see the table above.
- Do **not** write a bare type alias expecting parameterized generics:
  `type StringWrapper = Wrapper<String>;` also works, because the alias is a
  concrete type — but rustra does not emit `Wrapper<T>` templates. Each used
  instantiation becomes its own generated type.
- Older rustra releases leaked Rust's `type_name` into `inputType`
  (`Wrapper<String >` — not an identifier). If an old schema.json fails CLI
  validation with a "generic type name" error, rebuild the Rust package with
  the current rustra and regenerate `schema.json`.

### Optional Field Handling

```rust
struct Example {
    pub name: String,        // required
    pub age: Option<u32>,    // optional
}
```

```typescript
export type Example = {
  name: string;
  age?: number | null;
};
```

### Scalar Return Types

When the return value is a primitive (`i64`, `String`, `bool`), codegen does not inline
it — it emits a named alias in `types.ts` and uses it as the command's output type
(`int64` widens to `number | bigint`; `String` and `Boolean` are renames of
`string`/`boolean`). The input likewise keeps the single struct + `Result<O>` contract:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<i64> { Ok(input.a + input.b) }
```

<!-- prettier-ignore -->
```typescript
// Scalar outputs keep a generated alias for the widened primitive (i64 → number | bigint).
// Same shape as the actual codegen output for a scalar-returning command.
export type int64 = number | bigint;

export const addNumbers = createGeneratedFields2<AddNumbersInput, int64>(1, 'addNumbers', "a", "b", 'addNumbers');
```

### Generated types.ts Example

```typescript
export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AddNumbersInput = {
  a: number | bigint;
  b: number | bigint;
};

export type AddNumbersOutput = {
  value: number | bigint;
};
```

### Generated commands.ts Example

<!-- docs:sync:begin examples/calculator/generated/commands.ts -->

<!-- prettier-ignore -->
```typescript
import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoBytesInput, ChannelDemoBytesOutput, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DeviceDemoOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, KindEchoInput, KindEchoOutput, MultiplyInput, MultiplyOutput, PlatformNativeInfoOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedBytes, invokeGeneratedFields1, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export const addNumbers = createGeneratedFields2<AddNumbersInput, AddNumbersOutput>(1, 'addNumbers', "a", "b", 'addNumbers');

export const benchAdd = createGeneratedFields2<BenchAddInput, BenchAddOutput>(23, 'benchAdd', "a", "b", 'benchAdd');

export function benchEchoBytes(input: BenchBytesPayload, options?: InvokeOptions): Promise<BenchBytesPayload> {
  return invokeGeneratedBytes<BenchBytesPayload>(25, 'benchEchoBytes', input, input["data"], options);
}
benchEchoBytes.commandId = 'benchEchoBytes';

export const benchEchoPair = createGeneratedFields2<BenchPairPayload, BenchPairPayload>(26, 'benchEchoPair', "name", "value", 'benchEchoPair');

export function benchEchoString(input: BenchStringPayload, options?: InvokeOptions): Promise<BenchStringPayload> {
  return invokeGeneratedFields1<BenchStringPayload>(24, 'benchEchoString', input, input["value"], options);
}
benchEchoString.commandId = 'benchEchoString';

export const channelDemo = createGeneratedFields2<ChannelDemoInput, ChannelDemoOutput>(18, 'channelDemo', "channel", "ticks", 'channelDemo');

/**
 * 바이너리 채널 데모 — `channel_demo` 의 바이트 경로 쌍둥이. 모든 호스트 어댑터의 createBytesChannel/createChannelBytes 패리티를 동일 명령으로 e2e 검증한다(페이로드는 스텝 카운터 LE u64).
 */
export const channelDemoBytes = createGeneratedFields2<ChannelDemoBytesInput, ChannelDemoBytesOutput>(31, 'channelDemoBytes', "channel", "ticks", 'channelDemoBytes');

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(8, 'createItem', "name", "value", 'createItem');

export function deviceDemo(options?: InvokeOptions): Promise<DeviceDemoOutput> {
  return invokeGenerated<DeviceDemoOutput>(32, 'deviceDemo', undefined, options);
}
deviceDemo.commandId = 'deviceDemo';

export const divide = createGeneratedFields2<DivideInput, DivideOutput>(10, 'divide', "a", "b", 'divide');

export function echoGroups(input: EchoGroupsInput, options?: InvokeOptions): Promise<EchoGroupsOutput> {
  return invokeGenerated<EchoGroupsOutput>(27, 'echoGroups', input, options);
}
echoGroups.commandId = 'echoGroups';

export const emitDemo = createGeneratedFields2<EmitDemoInput, EmitDemoOutput>(11, 'emitDemo', "ticks", "stepDelayMs", 'emitDemo');

/**
 * u64/u32 필드 — plain varint(uvar) 와이어 고정(과거 zigzag 버그 수정 증명).
 */
export const gauge = createGeneratedFields2<GaugeInput, GaugeOutput>(17, 'gauge', "limit", "offset", 'gauge');

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGeneratedFields1<IsEvenOutput>(3, 'isEven', input, input["n"], options);
}
isEven.commandId = 'isEven';

export function kindEcho(input: KindEchoInput, options?: InvokeOptions): Promise<KindEchoOutput> {
  return invokeGenerated<KindEchoOutput>(33, 'kindEcho', input, options);
}
kindEcho.commandId = 'kindEcho';

export const multiply = createGeneratedFields2<MultiplyInput, MultiplyOutput>(2, 'multiply', "a", "b", 'multiply');

export function platformNativeInfo(options?: InvokeOptions): Promise<PlatformNativeInfoOutput> {
  return invokeGenerated<PlatformNativeInfoOutput>(30, 'platformNativeInfo', undefined, options);
}
platformNativeInfo.commandId = 'platformNativeInfo';

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invokeGenerated<ProcessItemOutput>(9, 'processItem', input, options);
}
processItem.commandId = 'processItem';

export function resourceClose(input: ResourceCloseInput, options?: InvokeOptions): Promise<ResourceCloseOutput> {
  return invokeGeneratedFields1<ResourceCloseOutput>(22, 'resourceClose', input, input["handle"], options);
}
resourceClose.commandId = 'resourceClose';

export function resourceOpen(input: ResourceOpenInput, options?: InvokeOptions): Promise<ResourceHandleOutput> {
  return invokeGenerated<ResourceHandleOutput>(19, 'resourceOpen', input, options);
}
resourceOpen.commandId = 'resourceOpen';

export const resourceRead = createGeneratedFields2<ResourceReadInput, ResourceReadOutput>(20, 'resourceRead', "handle", "key", 'resourceRead');

export function resourceWrite(input: ResourceWriteInput, options?: InvokeOptions): Promise<ResourceWriteOutput> {
  return invokeGeneratedFields3<ResourceWriteOutput>(21, 'resourceWrite', input, input["handle"], input["key"], input["value"], options);
}
resourceWrite.commandId = 'resourceWrite';

/**
 * 런타임 registry 제어 명령. op:
 * `register` / `unregister` / `replacePing` / `replaceAdd` / `restoreAdd` / `freeze` / `state`.
 */
export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invokeGeneratedFields1<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, input["op"], options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

/**
 * HashMap<String, i64>(동적 맵) — count + (key,value)* 와이어 고정.
 */
export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export const secureCompute = createGeneratedFields2<SecureComputeInput, SecureComputeOutput>(13, 'secureCompute', "a", "b", 'secureCompute');

/**
 * Vec<u8>(postcard bytes) 입력 + u32 출력 — plain varint 와이어 고정.
 */
export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGeneratedBytes<SizeOfOutput>(14, 'sizeOf', input, input["data"], options);
}
sizeOf.commandId = 'sizeOf';

/**
 * (String, i64) 튜플 — i64 때문에 complex-binary count + elements 와이어.
 */
export function span(input: SpanInput, options?: InvokeOptions): Promise<SpanOutput> {
  return invokeGenerated<SpanOutput>(16, 'span', input, options);
}
span.commandId = 'span';

export function sumList(input: SumListInput, options?: InvokeOptions): Promise<SumListOutput> {
  return invokeGenerated<SumListOutput>(6, 'sumList', input, options);
}
sumList.commandId = 'sumList';

export function tagSet(input: TagSetInput, options?: InvokeOptions): Promise<TagSetOutput> {
  return invokeGenerated<TagSetOutput>(29, 'tagSet', input, options);
}
tagSet.commandId = 'tagSet';

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invokeGeneratedFields1<ToUpperOutput>(7, 'toUpper', input, input["s"], options);
}
toUpper.commandId = 'toUpper';

/**
 * A2 와이드 정수 복합 타입 표본 — Vec<u64> + Option<i64>. 원소/옵션 레벨 uvar64/zigzag64 헬퍼가 스트림 중간 7바이트 varint 경계를 넘는 값을 무손실 왕복하는지 cross-wire 픽스처로 고정한다.
 */
export function wideAgg(input: WideAggInput, options?: InvokeOptions): Promise<WideAggOutput> {
  return invokeGenerated<WideAggOutput>(28, 'wideAgg', input, options);
}
wideAgg.commandId = 'wideAgg';
```

<!-- docs:sync:end -->

(`invokeGenerated` uses the engine registered by the generated host entry point via
`configureLazy()` — if the host adapter import precedes it, the call site never needs to
configure an engine itself)

---

## 10. Prelude

Brings the frequently used types and macros in at once:

```rust
use rustra::prelude::*;
```

Provided items:

| Item               | Kind            | Purpose                                   |
| ------------------ | --------------- | ----------------------------------------- |
| `build`            | function        | Creates a `PackageBuilder`                |
| `bridge_type`      | attribute macro | Automates struct/enum derives             |
| `command`          | attribute macro | Converts a function into a bridge command |
| `Package`          | struct          | The registered set of commands            |
| `PackageBuilder`   | struct          | The command registration builder          |
| `Result<T>`        | type alias      | `std::result::Result<T, RustraError>`     |
| `RustraError`      | struct          | The error type                            |
| `Serialize`        | trait           | serde serialization                       |
| `Deserialize`      | trait           | serde deserialization                     |
| `JsonSchema`       | trait           | JSON Schema generation                    |
| `GeneratedPackage` | struct          | The TypeScript generation result          |

---

## 11. Hot Core (`hot-core` feature, experimental)

Dev-time native hot-swap: the host opens a cdylib core, a watch thread polls the
artifact, and rebuilt bytes are swapped in without restarting the process. The
`hot-core` cargo feature adds the `libloading` dependency and nothing else moves —
the release static-link path is unchanged. The surface is experimental (the
experimental-surface table in [versioning-policy.md](versioning-policy.md));
contracts may break before 1.0.

### Type inventory (`rustra::hot_core`)

- `JsonDispatch` — `pub trait JsonDispatch: Send + Sync`; its single method
  `fn invoke_json(&self, command: &str, args: serde_json::Value)` returning
  `Result<serde_json::Value, serde_json::Value>`. Errors come back as the rustra
  error wire shape `{"code": ..., "message": ...}`. Implemented by `Package` (the
  static path) and `HotCoreHandle`; `Send + Sync` exists so `Arc<dyn JsonDispatch>`
  can live in Tauri managed state. (`JsonDispatch` itself compiles without
  `hot-core` — `tauri`-only hosts keep the dispatch indirection.)
- `DylibCore` — `DylibCore::open(artifact: &Path) -> Result<Self, DylibCoreError>`
  (dlopen `RTLD_LOCAL`, required-symbol bind, contract-hash read);
  `.invoke_json(command, args)`; `.contract_hash()` returning
  `Result<String, DylibCoreError>`.
- `DylibCoreError` — variants `Open`, `Symbol`, `ContractHash`, `Dispatch`,
  `Prepare`, `Codesign`, `Panic`. `Codesign` is a macOS ad-hoc re-sign failure
  surfaced loudly (no silent skip); `Panic` catches panics from open/swap so the
  watch thread and host survive.
- `HotCoreHandle` — `.new(core)`; `.swap(new: DylibCore) -> DylibCore` returns the
  old core — old libraries are deliberately never `dlclose`d; `.contract_hash()`;
  implements `JsonDispatch` by routing to the current core.
- `prepare_swap_copy(artifact: &Path, counter: u64)` returning
  `Result<PathBuf, DylibCoreError>` — makes a unique versioned copy of the
  artifact (and re-signs ad-hoc on macOS) so the mapped original is never
  overwritten; re-dlopening the same path would return the stale mapping.
- `SwapOutcome = Result<(String, String), DylibCoreError>` — Ok carries
  `(old_contract_hash, new_contract_hash)`; the `on_swap` callback type
  (`SwapCallback`) is `Arc<dyn Fn(SwapOutcome) + Send + Sync>`.
- `DylibWatchConfig` — fields `artifact: PathBuf`, `poll: Duration` (default
  300ms), `handle: Arc<HotCoreHandle>`, `on_swap: SwapCallback` (default no-op);
  constructor `DylibWatchConfig::new(artifact, handle)`.
- `spawn_dylib_watch(config) -> std::thread::JoinHandle<()>` — a std thread with
  sleep polling (no notify-style dependency); polls the artifact sha256 and
  applies swaps atomically.

### Retry cap

The same artifact bytes failing 5 consecutive swaps are poisoned and skipped
until different bytes are published — each failure still reports
`on_swap(Err(..))`, and new bytes always get a fresh retry window. Failed swaps
do not update the baseline hash either, so a half-written artifact mid-build
never kills the loop.

### Tauri glue (`tauri` + `hot-core`)

`tauri_support::HotSwapReporter` (`.new()`, `.report(outcome)`; the
`.install(sink)` step is plugin-internal, not public API) reports outcomes to
the reserved channel constant `HOT_SWAP_EVENT = "hot-core/swapped"` — the
webview channel is `rustra://hot-core/swapped`.
`tauri_support::register_dispatch_with_swap_events` — parameters
`dispatch: Arc<dyn JsonDispatch>`, `reporter: HotSwapReporter`, and
`builder: tauri::Builder<R>` (returns `tauri::Builder<R>`) — registers static
dispatch plus a `rustra-hot-swap` plugin that installs the reporter on the
Tauri event sink. Unlike `register_with_events`, package events are NOT wired
(the swap-drops-core-event-state policy is unchanged) — this function adds
exactly one new emission, the swap outcome. On the JS side the channel is
consumed by `subscribeHotSwap` from `@rustra/tauri` (see
[events-and-channels.md](events-and-channels.md)).

### Example

```rust
use std::sync::Arc;
use rustra::hot_core::{self, DylibCore, DylibWatchConfig, HotCoreHandle};
use rustra::tauri_support::{self, HotSwapReporter};

// 1) open the freshly built cdylib and wrap it in the shared swap point
let core = DylibCore::open(artifact)?;            // dlopen + symbol bind + init
let handle = Arc::new(HotCoreHandle::new(core));  // Arc<dyn JsonDispatch> → Tauri state

// 2) watch the artifact; report every swap outcome to the webview channel
let reporter = HotSwapReporter::new();
let mut config = DylibWatchConfig::new(artifact, handle.clone());
config.poll = std::time::Duration::from_millis(300); // default — shown for tuning
let sink = reporter.clone();
config.on_swap = Arc::new(move |outcome| {
    eprintln!("rustra hot-core: swap {outcome:?}");
    sink.report(outcome.map_err(|e| e.to_string()));
});
hot_core::spawn_dylib_watch(config);              // std thread, sha256 polling

// 3) static dispatch + the rustra-hot-swap plugin
tauri_support::register_dispatch_with_swap_events(handle, reporter, builder)
```

Design and status:
[2026-09-09 native hot core design](plans/2026-09-09-native-hot-core-design.md).
The React Native side of the same loop:
[`packages/react-native/README.md`](../packages/react-native/README.md).

---

## Appendix: Full Examples

### Advanced API Summary (public APIs not covered in the body)

**Event bus** — Rust → JS event push:

```rust
// Publish an event (droppable — ring buffer)
pkg.emit("item.created", serde_json::json!({ "id": "x1" }));

// Attach a native sink (e.g. RN JSI drain)
pkg.set_event_sink(Some(sink));
let bus = pkg.event_bus(); // direct EventBus access
```

Declare typed event contracts with `.event::<T>(name)` so codegen renders
`generated/events.ts` and the JS side subscribes type-safely. The full flow —
declaration → generated `events.ts` → per-host `subscribeEvent`/channels — is the
[events and channels guide](events-and-channels.md), with a working example in
[`examples/streaming`](../examples/streaming).

**Channels** — Rust → JS unicast reply streams (invocation-scoped; see
[compatibility matrix](compatibility-matrix.md#channel-delivery-path) for
per-host issuance):

```rust
use rustra::channels;

// Reserve a handle and install a sender (host adapters do this for you —
// this is the escape hatch for custom hosts)
let host = channels::host();
let handle = host.reserve_handle();
host.register_channel_with_handle(handle, std::sync::Arc::new(move |payload: &str| {
    // deliver `payload` to the JS side (emit, stdout frame, FFI callback, …)
}));

// A command's ChannelHandle argument sends replies back to the caller
assert!(channels::ChannelHandle(input.channel).send(r#"{"progress": 1}"#));
// Stale/dropped handles return false (silent-ignore contract made visible)
host.drop_channel(handle); // later sends report false
```

**Runtime Authority (capabilities)** — deny-by-default permissions:

```rust
// Require a capability at the builder
Package::builder("app.secure")
    .command("secureCompute", handler)
    .require_capability("secureCompute", "app.admin")
    .build();

// Grant at runtime — capability.denied until granted
pkg.grant_capability("app.admin")?;
```

**FFI (C ABI)** — calls via native modules/processes (`rustra::ffi`):

- `rustra_ffi_register` / `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard`
- `rustra_ffi_invoke_async` / `rustra_ffi_invoke_cancel` — checkpoint cancellation propagation
- `rustra_ffi_set_max_payload` / `rustra_ffi_contract_hash` / `rustra_ffi_schema_json`

**Freeze** — locking runtime mutation:

```rust
pkg.freeze();          // subsequent register/unregister fail with registry.frozen
assert!(pkg.is_frozen());
```

**Tauri support** (`tauri` feature) — `rustra::tauri_support`:

- `tauri_support::register(app, pkg)` — registers the invoke handler
- `tauri_support::register_with_events(...)` — includes event push
- `tauri_support::register_profiled(...)` — bench-only, exposes `rustra_dispatch_profiled`
- `tauri_support::rustra_dispatch(...)` — command dispatch
- `tauri_support::register_dispatch_with_swap_events(...)` — hot-core swap
  reporting on `rustra://hot-core/swapped` (see §11)

**Schema/version** — `pkg.schema()` (the full schema JSON), `pkg.live_schema()`
(including dynamic commands), the `.schema_version(v)` builder (T2/OTA negotiation).

### Calculator Example

```rust
use rustra::prelude::*;

#[bridge_type]
struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    pub value: i64,
}

#[bridge_type]
struct MultiplyInput {
    pub a: f64,
    pub b: f64,
}

#[bridge_type]
struct MultiplyOutput {
    pub value: f64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

#[command]
fn multiply(input: MultiplyInput) -> Result<MultiplyOutput> {
    Ok(MultiplyOutput {
        value: input.a * input.b,
    })
}

fn main() -> Result<()> {
    // runtime usage
    let pkg = rustra::build!("example.calculator", add_numbers, multiply).done();

    let sum: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", sum.value);

    // generate TypeScript
    pkg.generate_typescript()?.write_schema_to_dir("generated")?;

    Ok(())
}
```

### User Search Example

```rust
use rustra::prelude::*;

#[bridge_type]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}

#[bridge_type]
struct User {
    pub id: String,
    pub display_name: String,
    pub email: String,
}

#[command]
fn find_user(input: UserQuery) -> Result<User> {
    Ok(User {
        id: "u-001".into(),
        display_name: input.name,
        email: format!("{}@example.com", input.name.to_lowercase()),
    })
}

fn main() -> Result<()> {
    let pkg = rustra::build!("app.users", find_user).done();

    let user: User = pkg.invoke(
        "findUser",
        UserQuery { name: "Alice".into(), age: Some(30) },
    )?;
    println!("Found: {} ({})", user.display_name, user.email);

    pkg.generate_typescript()?.write_schema_to_dir("generated")?;
    Ok(())
}
```

### Error Handling Example

```rust
use rustra::prelude::*;

#[bridge_type]
struct DivisionInput {
    pub dividend: i64,
    pub divisor: i64,
}

#[bridge_type]
struct DivisionOutput {
    pub quotient: i64,
    pub remainder: i64,
}

#[command]
fn divide(input: DivisionInput) -> Result<DivisionOutput> {
    if input.divisor == 0 {
        return Err(RustraError::custom(
            "math.divide_by_zero",
            "cannot divide by zero",
        ));
    }
    Ok(DivisionOutput {
        quotient: input.dividend / input.divisor,
        remainder: input.dividend % input.divisor,
    })
}

fn main() -> Result<()> {
    let pkg = rustra::build!("math.division", divide).done();

    match pkg.invoke("divide", DivisionInput { dividend: 10, divisor: 3 }) {
        Ok(result) => println!("10 / 3 = {} (remainder: {})", result.quotient, result.remainder),
        Err(e) => eprintln!("[{}] {}", e.code(), e.message()),
    }

    Ok(())
}
```

---

## Appendix: Bootstrap Instance Ownership (single-engine slot)

Each JS host process owns **one global engine slot**. The generated host entry
point registers a bootstrap with `configureLazy()` (or an explicit engine with
`configure()`), and every invoke routes through that single slot.

Current policy (R08 — early guard):

- **First registration wins.** A second bootstrap registered while the first is
  still pending (registered but not yet consumed by the first `ready()`/invoke)
  throws `registry.frozen` — the import order no longer silently decides which
  engine serves commands.
- **Re-registration after consumption stays allowed.** `dispose()` + the same
  bootstrap closure (`reload()` on the Node/Bun adapters) re-registers freely;
  replacing a lazy initializer after consumption started, and recovery
  registration after a failed initialization, follow the existing contracts.
- **Multi-engine is not supported.** The guard exists to surface accidental
  cross-host registration loudly (`ownerId` on `configure`/`configureLazy`
  reports both parties in the error message); it is not a multi-engine API.

All first-party adapters (`createNodeBootstrap`, `createBunBootstrap`,
`createTauriBootstrap`, RN `createRustraBootstrap`) share the same slot path,
so the guard covers them automatically. Only the Node adapter passes `ownerId`
today — conflicts from the other adapters report the anonymous party in the
diagnostics.
