English | [한국어](./rust-api-guide.ko.md)

# rustra-bridge Rust API Guide

## 1. Overview

rustra-bridge is a bridge framework that automatically generates a TypeScript client — working from Node / Bun / Tauri / React Native alike — once you define commands in Rust.

```text
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

There are three core components:

| Component          | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `#[command]`       | Attribute macro that turns a function into a bridge command     |
| `#[bridge_type]`   | Automatically adds the required derives and serde settings to structs/enums |
| `rustra::build!()` | Creates the package builder and registers multiple commands at once |

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
// ✅ 올바른 반환
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

| Function name          | Command name                                |
| ---------------------- | ------------------------------------------- |
| `add_numbers`          | `addNumbers`                                |
| `find_user`            | `findUser`                                  |
| `do_something_command` | `doSomething` (`_command` suffix stripped automatically) |

To specify one directly, use the `name` attribute:

```rust
#[command(name = "calc.add")]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    // 커맨드 이름이 "addNumbers" 대신 "calc.add" 로 등록된다
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

If a trait bound is not satisfied, `#[diagnostic::on_unimplemented]` produces a friendly error message:

```text
error: `MyType` cannot be used as a command parameter
  --> src/main.rs:5:1
   |
5  | #[command]
   | ^^^^^^^^^ command parameters require Serialize + Deserialize + JsonSchema
   |
   = note: add `#[rustra::bridge_type]` to `MyType`
```

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
    pub field_name: String, // JSON에서 "field_name"으로 유지
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
// 등록 + 빌드
let pkg = rustra::build!("examples.calculator", add_numbers, multiply).done();

// TypeScript 생성은 Package 의 generate_typescript 에서
pkg.generate_typescript()?.write_to_dir("generated")?;
```

### What the Macro Expands To

Calling `rustra::build!("examples.calculator", add_numbers)` expands to:

```rust
rustra::Package::builder("examples.calculator")
    .command(__RUstra_meta_add_numbers, __rustra_add_numbers_handler)
```

For each `#[command]` function, the macro generates:

| Generated item      | Naming rule                  | Role                                                          |
| ------------------- | ---------------------------- | ------------------------------------------------------------- |
| Metadata constant   | `__RUstra_meta_<fn_name>`    | A `&str` constant holding the command name                    |
| Handler function    | `__rustra_<fn_name>_handler` | A wrapper performing input type conversion and Ok() wrapping  |
| Trait bound check   | `_check_command_bounds`      | Verifies the I/O types satisfy the required traits            |

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

If the schema is not exactly one required `uint8` array field, the build stage panics so
the direct ABI is never advertised incorrectly. Input JS memory is borrowed only for the
duration of the synchronous call, and the Rust output allocation is freed by the JSI
`ArrayBuffer` at end of life. For the detailed contract see the
[direct byte-buffer design](plans/2026-08-24-rn-byte-buffer-native-path.md).

### Other Builder Methods

| Method                                  | Role                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `.require_capability(name, cap)`        | Requires a capability for a command (deny-by-default Runtime Authority) |
| `.buffer_command_fn(handler)`           | Registers the name-inferred single `Vec<u8>` direct path        |
| `.buffer_command(name, handler)`        | Registers the explicitly named single `Vec<u8>` direct path     |
| `.alias_command_id(command, legacy_id)` | Registers a legacy cmd_id alias (backward-compatible dispatch)  |
| `.event_capacity(capacity)`             | Sets the event bus ring buffer capacity                        |
| `.schema_version(version)`              | Declares the schema negotiation version (T2, OTA)               |
| `.manage(state)`                        | Registers shared state (accessed via `Package::state::<T>()`)   |

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

Generates the TypeScript client code from all registered commands.

```rust
let generated = pkg.generate_typescript()?;
```

---

## 7. GeneratedPackage

The struct holding the TypeScript code generation result.

| Field           | Output file   | Content                                  |
| --------------- | ------------- | ---------------------------------------- |
| `schema_json`   | `schema.json` | The full command schema (JSON)           |
| `types_ts`      | `types.ts`    | TypeScript type definitions              |
| `commands_ts`   | `commands.ts` | TypeScript command helper functions      |
| `contract_hash` | `contract.ts` | The schema's SHA-256 hash (integrity verification) |

### `.write_to_dir(dir)`

Writes the four files into the given directory, creating it if it does not exist.

```rust
let generated = pkg.generate_typescript()?;
generated.write_to_dir("generated")?;
```

The generated files:

```text
generated/
  schema.json      # 전체 명령 스키마
  types.ts         # TypeScript 타입 정의
  commands.ts      # TypeScript 명령 헬퍼 함수
  contract.ts      # GENERATED_CONTRACT_HASH 상수
```

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

#[command]
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("division.by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
}
```

### Error Code Classification

| Code                   | Factory method                         | Meaning                                 |
| ---------------------- | -------------------------------------- | --------------------------------------- |
| `command.not_found`    | `RustraError::command_not_found(name)` | Invoking an unregistered command        |
| `command.invalid_args` | `RustraError::invalid_args(error)`     | Input argument deserialization failure  |
| `capability.denied`    | `RustraError::capability_denied(d)`    | Capability not granted                  |
| `transport.error`      | `RustraError::transport(error)`        | Transport/network error — **retryable** |
| `transport.timeout`    | `RustraError::timeout(error)`          | Timeout — **retryable**                 |
| `internal`             | `RustraError::internal(error)`         | Internal error (serialization, I/O, etc.) |
| (custom)               | `RustraError::custom(code, message)`   | User-defined error                      |

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

| Rust type                     | TypeScript type                         |
| ----------------------------- | --------------------------------------- |
| `i64`, `i32`, `u32`, `f64`, etc. | `number`                             |
| `String`                      | `string`                                |
| `bool`                        | `boolean`                               |
| `Option<T>`                   | `T \| null` (struct fields use `?:`)    |
| `Vec<T>`                      | `T[]`                                   |
| `Vec<Vec<T>>`                 | `T[][]` (nesting supported)             |
| `HashMap<String, V>`          | `Record<string, V>`                     |
| `BTreeSet<T>` / `HashSet<T>`  | `Set<T>` (`uniqueItems` mapping)        |
| `(A, B, C)`                   | `[A, B, C]` (tuple)                     |
| Simple `enum`                 | `'Variant1' \| 'Variant2'`              |
| Data-carrying `enum`          | Object union type                       |

### Optional Field Handling

```rust
struct Example {
    pub name: String,        // 필수
    pub age: Option<u32>,    // 선택적
}
```

```typescript
export type Example = {
  name: string;
  age?: number | null;
};
```

### Scalar Return Types

When the return value is a primitive (`i64`, `String`, `bool`), TypeScript inlines it
directly without a separate type alias. The input likewise keeps the single struct +
`Result<O>` contract:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<i64> { Ok(input.a + input.b) }
```

```typescript
// 스칼라 출력은 Promise<number> — type alias 없이 inline된다.
// 실제 생성물(examples/calculator/generated/commands.ts)과 동일한 형태다.
export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<number> {
  return invokeGenerated<number>(1, 'addNumbers', input, options);
}
addNumbers.commandId = 'addNumbers';
```

### Generated types.ts Example

```typescript
export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AddNumbersInput = {
  a: number | bigint; // i64 → number | bigint (와이어 정합)
  b: number | bigint;
};
```

### Generated commands.ts Example

```typescript
import type { AddNumbersInput, AddNumbersOutput } from './types.js';
import { invokeGenerated } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<number> {
  return invokeGenerated<number>(1, 'addNumbers', input, options);
}
addNumbers.commandId = 'addNumbers';
```

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

| Item               | Kind        | Purpose                               |
| ------------------ | ----------- | ------------------------------------- |
| `build`            | function    | Creates a `PackageBuilder`            |
| `bridge_type`      | attribute macro | Automates struct/enum derives     |
| `command`          | attribute macro | Converts a function into a bridge command |
| `Package`          | struct      | The registered set of commands        |
| `PackageBuilder`   | struct      | The command registration builder      |
| `Result<T>`        | type alias  | `std::result::Result<T, RustraError>` |
| `RustraError`      | struct      | The error type                        |
| `Serialize`        | trait       | serde serialization                   |
| `Deserialize`      | trait       | serde deserialization                 |
| `JsonSchema`       | trait       | JSON Schema generation                |
| `GeneratedPackage` | struct      | The TypeScript generation result      |

---

## Appendix: Full Examples

### Advanced API Summary (public APIs not covered in the body)

**Event bus** — Rust → JS event push:

```rust
// 이벤트 발행 (드랍 가능 — 링 버퍼)
pkg.emit("item.created", serde_json::json!({ "id": "x1" }));

// 네이티브 싱크 연결 (RN JSI 드레인 등)
pkg.set_event_sink(Some(sink));
let bus = pkg.event_bus(); // EventBus 직접 접근
```

**Runtime Authority (capabilities)** — deny-by-default permissions:

```rust
// 빌더에서 요구 지정
Package::builder("app.secure")
    .command("secureCompute", handler)
    .require_capability("secureCompute", "app.admin")
    .build();

// 런타임 부여 — 부여 전까지 capability.denied
pkg.grant_capability("app.admin")?;
```

**FFI (C ABI)** — calls via native modules/processes (`rustra::ffi`):

- `rustra_ffi_register` / `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard`
- `rustra_ffi_invoke_async` / `rustra_ffi_invoke_cancel` — checkpoint cancellation propagation
- `rustra_ffi_set_max_payload` / `rustra_ffi_contract_hash` / `rustra_ffi_schema_json`

**Freeze** — locking runtime mutation:

```rust
pkg.freeze();          // 이후 register/unregister 는 registry.frozen 에러
assert!(pkg.is_frozen());
```

**Tauri support** (`tauri` feature) — `rustra::tauri_support`:

- `tauri_support::register(app, pkg)` — registers the invoke handler
- `tauri_support::register_with_events(...)` — includes event push
- `tauri_support::rustra_dispatch(...)` — command dispatch

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
    // 런타임 사용
    let pkg = rustra::build!("example.calculator", add_numbers, multiply).done();

    let sum: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", sum.value);

    // TypeScript 생성
    pkg.generate_typescript()?.write_to_dir("generated")?;

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

    pkg.generate_typescript()?.write_to_dir("generated")?;
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
            "division.by_zero",
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
        Ok(result) => println!("10 / 3 = {} (나머지: {})", result.quotient, result.remainder),
        Err(e) => eprintln!("[{}] {}", e.code(), e.message()),
    }

    Ok(())
}
```
