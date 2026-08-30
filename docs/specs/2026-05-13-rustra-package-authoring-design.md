# Rustra Package Authoring Design

## Goal

The public product is a Rust package authors can use directly. A user writes typed Rust command functions, registers them in a `rustra::Package`, and generates a host-neutral TypeScript client.

## Public Shape

The first screen should look like this:

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

let package = Package::builder("example.calculator")
    .command("addNumbers", add_numbers)
    .build();

package.generate_typescript()?.write_to_dir("generated")?;
```

The user should not handle `EngineRequest`, `Attachment`, transport lanes, native bridge code, or internal registry types.

## Internal Boundary

`rustra` is the facade crate. Internals such as envelope, attachment, contract hashing, host adapters, and benchmarks can remain as lower-level crates, but they are not the authoring API.

The generated TypeScript client depends only on:

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

## Acceptance Criteria

- `cargo test -p rustra` passes.
- `cargo test -p rustra --example basic` passes.
- `crates/rustra/README.md` shows the author-facing API without raw engine internals.
- Generated command helpers do not mention `EngineRequest`, `Attachment`, `node:`, or `react-native`.
- Existing workspace tests still pass.
