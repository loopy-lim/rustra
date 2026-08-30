# Independent Releases and Complex Data Contracts

**Status:** Active implementation design
**Date:** 2026-08-27

## Goal

Close the current release candidate with reproducible consumer evidence, then
make Rustra safe to evolve as independently versioned packages while extending
binary transport support to recursive and data-rich schemas without silently
losing fields.

## Current evidence and gaps

- The repository is on the 0.4.0 line. Workspace tests, package tests,
  compatibility tests, builds, and the current React Native package archive
  check pass.
- The working tree already contains an uncommitted React Native native-path
  fix. It remains part of this effort and must not be discarded.
- `.changeset/config.json` fixes all nine public npm packages together, and
  `scripts/check-release-coherence.mjs` additionally requires npm and Cargo
  versions to be exactly equal.
- CI builds local workspace React Native dependencies. It does not compile a
  clean native consumer using the packed adapter that will be published.
- The current postcard generator supports a useful subset, but data-carrying
  `oneOf` enums, complex-valued maps, and several nested combinations are
  intentionally routed to Tier 3 JSON-in-binary.
- The CLI and Rust runtime each maintain overlapping codec-support logic. A
  change in one side can otherwise create a wire mismatch.

## Decisions

### 1. Versioning model

Public packages are independently versioned. A package may keep the same
version as another package when their API changes together, but the tooling
must not require that coincidence.

- `@rustra/types` is the protocol/runtime contract package.
- Host adapters (`node`, `bun`, `tauri`, `react`, `react-native`, `testing`,
  `devtools`) declare semver ranges for the types contract they consume.
- `@rustra/cli` carries an explicit Rust compatibility range for generated
  projects. The CLI package version is not treated as the Rust crate version.
- `rustra` and `rustra-macros` remain a tightly compatible Cargo pair, but
  their pair version is independent from npm packages and examples.
- Examples are unpublished fixtures and do not participate in release
  coherence.

Release validation therefore checks dependency ranges, package manifests,
lockfile consistency, and generated-template compatibility. It does not check
that every public package has the same version.

### 2. Binary contract layers

The existing postcard fast path remains unchanged for schemas already proven
compatible. A new schema-driven `complex` binary path is added for types that
cannot be proven safe from the current postcard subset.

The complex path has one canonical wire format shared by Rust, generated
TypeScript, generated C++, and all hosts:

```text
request  = command_id:u16-le + complex-value
response = ok:u8 + reserved:7 + complex-value
```

The complex-value format is recursive and length-delimited:

- primitives use explicit scalar tags and little-endian fixed-width or
  varint payloads;
- strings and byte sequences carry a bounded length;
- arrays/sets carry an element count and recursively encoded elements;
- maps carry a count and sorted UTF-8 keys, followed by recursively encoded
  values;
- structs carry fields in schema declaration order;
- options carry a `none/some` tag;
- data enums carry a canonical variant index followed by the variant payload.

The schema emits the canonical enum variant order as explicit metadata. The
codec never guesses variant order from a reordered `oneOf` array. Recursive
schemas are bounded by a configurable maximum depth and payload byte limit.

Postcard and complex codecs are selected per command in generated metadata.
Unsupported schemas are still allowed to use the Tier 3 JSON fallback, but the
generator must print the exact reason and route; it must never register a
partial codec.

### 3. Shared codec intermediate representation

The CLI owns a single schema-to-codec IR. It is used to generate TypeScript
and C++, and its support classification is serialized into generated metadata.
Rust consumes the same schema metadata for the dynamic complex path. The Rust
and TypeScript support checks are tested against the same golden schema corpus.

The IR must represent recursive references, struct fields, map value types,
enum variants and payload fields, tuple positions, options, and collection
element types. It must retain field/variant declaration order and reject
ambiguous schemas before generating code.

### 4. Evidence gates

Release claims require all of the following:

- package-specific changesets and a passing independent-version coherence
  check;
- local pack and clean consumer install checks;
- packed React Native adapter Android and iOS native build checks;
- generated-code fixture tests for postcard and complex routes;
- Rust/TypeScript/C++ byte-level golden fixtures;
- workspace tests, host compatibility tests, and lint/format checks;
- benchmark receipts for representative simple and complex shapes.

No registry publish is performed by this implementation work without explicit
publish authorization.

## Implementation order

1. Finish release candidate validation and independent versioning.
2. Add packed React Native consumer build gates and improve package resolver
   diagnostics.
3. Introduce the shared codec IR and schema metadata for complex types.
4. Implement Rust dynamic complex encode/decode and generated TypeScript
   codecs with golden fixtures.
5. Implement generated C++ complex marshal/decode for React Native.
6. Add benchmark/DX tooling, update the type support matrix, and remove stale
   release/testing claims.

Each phase must leave the existing postcard path green and produce its own
testable receipt before the next phase begins.

## Non-goals

- Reintroducing deleted Lynx packages.
- Replacing the proven postcard fast path solely for architectural purity.
- Claiming physical-device runtime support from a simulator or build result.
- Publishing npm or crates.io artifacts without a separate user-approved
  release action.
