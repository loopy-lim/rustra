# Architecture Boundary Refactor Design

## Goal

Make the architecture-boundary gate pass by splitting oversized implementation files by responsibility while preserving public APIs, generated wire bytes, error strings, and runtime behavior.

## Current violations

- `crates/rustra/src/lib.rs` is 204 lines against a 200-line facade budget.
- `crates/rustra/src/complex_schema_ir.rs` is 449 lines and exceeds the 400-line hard ceiling.
- `crates/rustra/src/complex_serde.rs` is 2184 lines and exceeds the 400-line hard ceiling.
- `packages/types/src/schema-postcard-codec.ts` is 603 lines and exceeds the 400-line hard ceiling.

## Design

1. Move `postcard_uvar_len` into the existing `invoke_buffer.rs` include scope so `lib.rs` remains a public facade.
2. Keep the IR data types and small public-in-module entry points in `complex_schema_ir.rs`; move `Context` and schema compilation methods into `complex_schema_ir_compile.rs` with `include!`, preserving the current private namespace.
3. Split the TypeScript schema postcard codec into wire primitives, schema-node compilation, and the public codec assembler. The existing `createSchemaPostcardCodec` export remains in `schema-postcard-codec.ts`.
4. Split the Rust serde adapter into support, deserialization core/access helpers, serialization core/access helpers, and a `_tests.rs` file. Use the repository's existing `include!` composition pattern so private types and lifetimes remain unchanged.

## Compatibility constraints

- Do not change exported Rust or TypeScript names.
- Do not change command IDs, schema classification, wire layout, or error text.
- Do not change package versions, changesets, publishing metadata, or documentation outside this design/plan record.
- Preserve all existing tests; add no new runtime behavior.

## Verification

Run the architecture test after each logical split, then run Rust formatting, Rust workspace tests, TypeScript package tests, full compatibility tests for Node/Bun/RN/Tauri, and `git diff --check`. The final architecture report must contain no errors, and every production module must be at or below the 400-line hard ceiling with `lib.rs` at or below 200 lines.
