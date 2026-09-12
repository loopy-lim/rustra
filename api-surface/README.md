# Source API declaration gate (snapshot v3)

`node scripts/api-surface.mjs` compares current source declarations with `snapshot.json`.
A missing snapshot, wrong version, collector failure or declaration drift exits nonzero.
`node scripts/api-surface.mjs --update` intentionally replaces the baseline only after
collection succeeds. Review the resulting snapshot diff with the API change.

Run focused regressions with:

```sh
node --experimental-strip-types --test scripts/api-surface.test.ts
cargo fmt --manifest-path scripts/api-surface-rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path scripts/api-surface-rust/Cargo.toml --target-dir target/api-surface-rust -- -D warnings
```

The gate requires the installed workspace TypeScript dependency and Cargo/Rust (edition
2024 and let-chains; Rust 1.88+). Its private, unpublished Rust parser has an independent
workspace and committed lockfile. Each collection runs Cargo with `--locked`, storing
build artifacts under the repository's ignored `target/api-surface-rust` directory.
The first run needs the parser dependencies available in the Cargo cache or registry.
It does not build application crates, expand macros or run application code.

## TypeScript boundary

- Read each non-private `packages/*/package.json`, including all explicit `exports`
  subpaths and nested conditional/array targets. Pin package names, targets and condition
  order, because condition order affects Node resolution. Without `exports`, use
  `types`, then `main`, then the conventional index entry. JSON exports other than the
  package manifest also pin their contents; other package metadata is out of scope.
- Map declared output files to existing source files via `tsconfig.json`'s `rootDir` and
  `outDir` (default `src` and `dist`). Supported extensions are TS/TSX/MTS/CTS and source
  declaration files. Missing source, package-escaping paths, wildcard exports and
  unsupported asset targets fail rather than silently skipping the entry.
- Use the TypeScript compiler API to emit declarations **in memory from current source**.
  Resolve workspace package names and subpaths back to their current source entries.
  Built workspace `dist` declarations cannot satisfy these references. No build outputs
  are written or updated. Syntax, semantic and declaration errors originating in
  workspace sources fail collection, including source `.d.ts`/`.d.mts`/`.d.cts`.
- Traverse emitted declaration imports, reexports, import types and referenced files from
  every export target. Pin the compiler-printed declaration text of each reachable local
  module, including signatures, overloads, parameter/return types, fields, generics,
  aliases, classes, namespaces and default exports. Inferred public types come from the
  current implementation. Comments and implementation bodies are excluded by declaration
  emit, but implementation changes that alter inferred types are detected.
- This is a conservative **module declaration graph**, not minimal per-symbol reachability:
  other exports in a referenced module and declarations emitted for private type support
  may trigger review even if no consumer entry exposes them independently. Compiler
  settings are the repository's shared strict ES2022/NodeNext/React JSX declaration
  settings, not arbitrary custom per-package emit transforms. External dependency
  declarations participate in type resolution but are not recursively snapshotted;
  diagnostics originating inside `node_modules` are excluded. Errors reported in
  workspace sources, including unresolved external imports, still fail. Ambient
  modules such as `node:fs` resolve through installed TypeScript declarations.

## Rust boundary

- Parse `crates/rustra/src/lib.rs` and `crates/rustra-macros/src/lib.rs` with `syn`, following
  public **and private** inline/file modules, literal `#[path]` modules and literal
  `include!` files. This covers reexports from private modules and methods split across
  include files. Missing files, parse errors, include cycles, nonliteral includes and
  module `cfg_attr` forms fail closed. Explicit `#[cfg(test)]` declarations are excluded.
- Pin public functions (including C ABI, safety, generics, parameters and returns),
  modules, all use declarations (including multiline groups and aliases), type aliases,
  structs/unions with public fields and an opaque-field marker, enum variants, traits
  and associated items, constants, public static types, inherent public method signatures
  and trait implementations. Private type declarations, aliases, imports and constants
  are included conservatively: they can affect public signatures indirectly without
  changing the public function's spelling. Private field types and function/default
  method bodies are excluded; tuple private-field positions remain opaque placeholders.
- Retain non-doc attributes (e.g. `cfg`, `repr`, derives and proc-macro registration),
  generics, trait bounds and where clauses. Keep every cfg alternative rather than only
  the host's active features. Ancestor module/include attributes accompany declarations.
  Conditional duplicates are sorted and retained rather than picking one definition.
- Public `macro_rules!` definitions and module/impl macro invocations are pinned as
  opaque token declarations. Proc-macro registrations include derive names and helper
  attributes. **Macro-generated APIs and proc-macro implementation behavior are not
  expanded or semantically analyzed.** External crate reexports pin their import paths,
  not the external crate's complete contents. Other Rust crates are outside this gate.

This gate identifies source declaration additions, removals and changes; it does not
classify whether a change is semver-compatible or prove ABI layout, symbol/linker
compatibility, runtime behavior or complete rustc name resolution. Its conservative
Rust/module inventory can flag internal declaration refactors. Formatting normalization
removes comments and ordinary whitespace, but token-level changes such as rearranged
imports or trailing commas can still require intentional snapshot review. Compiler/parser
upgrades may likewise require a reviewed baseline update. Separate builds, behavioral
tests, compatibility tests and generated-binding checks remain necessary.
