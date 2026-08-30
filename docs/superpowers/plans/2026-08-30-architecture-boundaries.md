# Architecture Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the four oversized Rust/TypeScript implementation files so the existing architecture-boundary gate passes without changing runtime behavior or public APIs.

**Architecture:** Keep small facades at the existing entry paths. Move implementation blocks into responsibility-focused files, using `include!` for Rust files that share private types and imports, and normal TypeScript imports for the schema postcard codec. Existing tests remain the behavior contract.

**Tech Stack:** Rust, serde, serde_json, TypeScript, Bun, Cargo, existing architecture-boundary checker.

**Spec:** `docs/superpowers/specs/2026-08-30-architecture-boundaries-design.md`

## Global Constraints

- Preserve public Rust/TypeScript exports and all wire bytes.
- Do not change package versions, changesets, publishing metadata, or unrelated documentation.
- Keep each production source file at or below the existing 400-line hard ceiling.
- Keep `crates/rustra/src/lib.rs` at or below its 200-line facade budget.
- Preserve the current docs worktree files and do not stage them.

---

### Task 1: Shrink the Rust public facade

**Files:**

- Modify: `crates/rustra/src/lib.rs`
- Modify: `crates/rustra/src/invoke_buffer.rs`

**Interfaces:**

- Consumes: the existing `invoke.rs` `include!("invoke_buffer.rs")` composition.
- Produces: the same private `postcard_uvar_len` helper for `Package::invoke_buffer`.

- [ ] **Step 1: Confirm the red guard**

Run `bun run test:architecture` and confirm the `rustra-lib-size` violation is present.

- [ ] **Step 2: Move only the helper**

Move the existing `postcard_uvar_len` function from `lib.rs` to the top-level scope of `invoke_buffer.rs`. Do not change its body or call sites.

- [ ] **Step 3: Verify the focused result**

Run `cargo test -p rustra` and `bun run test:architecture`. The Rust crate must pass and the `rustra-lib-size` error must be absent.

### Task 2: Split schema IR compilation

**Files:**

- Modify: `crates/rustra/src/complex_schema_ir.rs`
- Create: `crates/rustra/src/complex_schema_ir_compile.rs`

**Interfaces:**

- Consumes: `IrNode`, `IrField`, `IrMatcher`, `IrBody`, `IrVariant`, and `compiled_ref` from the current IR module.
- Produces: the same `pub(crate) fn compile` entry point and identical compiled IR.

- [ ] **Step 1: Move compiler implementation**

Move `Context`, `MAX_DEPTH`, `compile`, and all `Context` compilation methods into `complex_schema_ir_compile.rs`. Keep the existing data types and `compiled_ref` in `complex_schema_ir.rs`, and include the compiler file from the IR module.

- [ ] **Step 2: Verify IR behavior**

Run `cargo test -p rustra` and confirm all complex codec tests pass with unchanged wire fixtures.

- [ ] **Step 3: Verify file boundary**

Run `bun run test:architecture` and confirm no `source-module-size` error remains for either IR file.

### Task 3: Split the TypeScript schema postcard codec

**Files:**

- Modify: `packages/types/src/schema-postcard-codec.ts`
- Create: `packages/types/src/schema-postcard-wire.ts`
- Create: `packages/types/src/schema-postcard-node.ts`

**Interfaces:**

- Consumes: `ComplexSchema`, `RkyvV2Codec`, and the existing UTF-8 helpers.
- Produces: the unchanged `createSchemaPostcardCodec` export and the same encode/decode behavior.

- [ ] **Step 1: Extract wire primitives**

Move varint, zigzag, string, float, and byte-concatenation helpers into `schema-postcard-wire.ts` with explicit exports for the node compiler and facade.

- [ ] **Step 2: Extract schema-node compilation**

Move `Encoder`, `Decoder`, `SchemaNode`, reference/option classification, `compileNode`, and `compileStruct` into `schema-postcard-node.ts`. Import the wire helpers and export only the compiler entry required by the facade.

- [ ] **Step 3: Keep the public assembler small**

Update `schema-postcard-codec.ts` to import the compiler and wire helpers, retaining frame validation, error decoding, and `createSchemaPostcardCodec`.

- [ ] **Step 4: Verify TypeScript behavior**

Run `bun run --cwd packages/types build`, `bun run --cwd packages/types test`, and the existing cross-wire tests. Confirm all postcard fixture bytes remain identical.

### Task 4: Split the Rust serde adapter

**Files:**

- Modify: `crates/rustra/src/complex_serde.rs`
- Create: `crates/rustra/src/complex_serde_support.rs`
- Create: `crates/rustra/src/complex_serde_de_core.rs`
- Create: `crates/rustra/src/complex_serde_de_access.rs`
- Create: `crates/rustra/src/complex_serde_ser_core.rs`
- Create: `crates/rustra/src/complex_serde_ser_access.rs`
- Create: `crates/rustra/src/complex_serde_ser_map_key.rs`
- Create: `crates/rustra/src/complex_serde_ser_struct.rs`
- Create: `crates/rustra/src/complex_serde_tests.rs`

**Interfaces:**

- Consumes: the current `from_bytes`, `to_bytes`, `to_writer`, `serde_direct_supported`, and private serde adapter types.
- Produces: the same `complex_serde` private module API used by `complex_codec_encode_object.rs`.

- [ ] **Step 1: Extract support and tests**

Move the serde error implementations and direct-support gate to `complex_serde_support.rs`. Move the current `#[cfg(test)] mod tests` to `complex_serde_tests.rs`, included only under `#[cfg(test)]`.

- [ ] **Step 2: Extract deserialization**

Move `from_bytes` and `De`/`Deserializer` implementation to `complex_serde_de_core.rs`; move enum, sequence, map, and auxiliary deserializer access implementations to `complex_serde_de_access.rs`.

- [ ] **Step 3: Extract serialization**

Move `to_bytes`, `to_writer`, and `Ser`/`Serializer` implementation to `complex_serde_ser_core.rs`; move sequence/map access implementations to `complex_serde_ser_access.rs`, map-key rejection helpers to `complex_serde_ser_map_key.rs`, and struct access implementations to `complex_serde_ser_struct.rs`.

- [ ] **Step 4: Preserve shared namespace**

Use `include!` from `complex_serde.rs` in dependency order, retaining the current imports at the shared module scope so private type visibility and generic lifetimes do not change.

- [ ] **Step 5: Verify serde parity**

Run `cargo test -p rustra`, the complex codec wire fixture tests, and the full workspace test. Confirm all direct serde round trips and Value-path byte comparisons pass.

### Task 5: Final gate and host verification

**Files:**

- No additional source changes unless a verification failure identifies a regression in the split.

- [ ] **Step 1: Run architecture and formatting gates**

Run `bun run test:architecture`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `bun run format:check`, and `git diff --check`.

- [ ] **Step 2: Run all functional gates**

Run `bun run test`, `cargo test --workspace`, `bun run test:packages`, and `bun run test:compat`.

- [ ] **Step 3: Recheck the four host paths**

Confirm the Node, Bun, React Native, and Tauri package tests and runtime smoke results remain successful.

- [ ] **Step 4: Inspect scope**

Run `git status --short --branch -uall` and verify only architecture-refactor files plus the already-present docs worktree files are changed; do not stage or remove the docs files.
