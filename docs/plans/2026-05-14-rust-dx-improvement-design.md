# Rust DX Improvement Design

## Problem

Current Rust API requires excessive boilerplate for defining commands:

- Every struct needs 4 derives + `#[serde(rename_all = "camelCase")]`
- Manual `Package::builder().command_fn()` registration
- Manual `generate_typescript()?.write_to_dir()` codegen
- Poor error messages when trait bounds aren't met

## Design: tRPC-style Minimal API

### 1. Enhanced `#[command]` Macro

Three invocation patterns:

```rust
// Pattern 1: Scalar params + scalar return (simplest)
#[command]
fn add_numbers(a: i64, b: i64) -> i64 { a + b }

// Pattern 2: Scalar params + Result return
#[command]
fn divide(a: i64, b: i64) -> Result<i64> { ... }

// Pattern 3: Custom types (struct params)
#[command]
fn find_user(query: UserQuery) -> Result<User> { ... }
```

**Macro behavior for scalar params (Pattern 1-2):**

- Auto-generates `__<PascalCase>Input` struct with `BridgeType` derives
- Auto-generates `__<PascalCase>Output` struct wrapping return value
- Wraps original function body into the generated handler
- Generates metadata constant for registration

**Macro behavior for struct params (Pattern 3):**

- Same as current behavior, passes struct directly
- Requires param type to implement `BridgeType` traits

### 2. `#[derive(BridgeType)]`

Single derive replacing `Debug + Serialize + Deserialize + JsonSchema` + `#[serde(rename_all = "camelCase")]`:

```rust
#[derive(BridgeType)]
struct UserQuery { pub name: String, pub age: Option<u32> }

#[derive(BridgeType)]
enum Status { Active, Inactive, Suspended }
```

Auto-adds:

- `Debug + Serialize + Deserialize + JsonSchema` derives
- `#[serde(rename_all = "camelCase")]` attribute

Override support:

```rust
#[derive(BridgeType)]
#[bridge(rename_all = "snake_case")]
struct RawQuery { ... }

#[derive(BridgeType, PartialEq)]
struct Comparable { ... }
```

### 3. Unified Registration + Codegen API

Replace `Package::builder()` + `register!()` + `generate_typescript()` with single chain:

```rust
fn main() -> Result<()> {
    rustra::build("examples.calculator")
        .commands!(add_numbers, multiply, divide)
        .generate_to("../generated")?
}
```

**`rustra::build("package.name")`:**

- Creates a `PackageBuilder` with package name

**`.commands!(fn1, fn2, ...)`:**

- Macro that references each function's metadata constant
- Auto-registers all commands with correct names and schemas

**`.generate_to("path")?`:**

- Generates TypeScript types, commands, schema, contract
- Writes all files to the specified directory

**`.package()`:**

- Returns `Package` for runtime use (FFI invocation)

### 4. Error Messages

Use `#[diagnostic::on_unimplemented]` on sealed traits:

```rust
#[diagnostic::on_unimplemented(
    message = "`{Self}` cannot be used as a command parameter",
    label = "command parameters require BridgeType traits",
    note = "add `#[derive(BridgeType)]` to `{Self}`"
)]
pub trait CommandInput: Serialize + DeserializeOwned + JsonSchema {}
```

### 5. Migration Strategy

No backward compatibility. Direct replacement:

- Remove `register!()` macro → replace with `commands!()`
- Remove `Package::builder()` → replace with `rustra::build()`
- Remove `generate_typescript()?.write_to_dir()` → replace with `.generate_to()`
- Update all examples to new API

## Affected Crates

- `rustra-macros`: `#[command]` rewrite, new `BridgeType` derive, new `commands!()` macro
- `rustra`: New `rustra::build()` API, remove old `Package::builder()`, `register!()`
- `examples/*`: Update all examples to new API
- Tests: Update to new patterns
