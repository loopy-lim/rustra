---
'@rustra/cli': minor
'@rustra/node': patch
'@rustra/bun': patch
'@rustra/types': patch
'@rustra/devtools': patch
'@rustra/tauri': patch
'@rustra/testing': patch
'@rustra/react': patch
'@rustra/react-native': patch
---

Single-arrow codegen: the Rust bin is a contract probe that publishes `schema.json`
only (`GeneratedPackage::write_schema_to_dir`, honoring `RUSTRA_SCHEMA_OUT`), and
`rustra codegen` renders every TS/C++ surface from that single file — the dual-pass
trap of two writers producing the same files is gone. `GeneratedPackage::write_to_dir`
is deprecated (documentation-only; kept at least one minor per the versioning policy).
DX additions in `@rustra/cli`: self-describing headers on every generated file
(file, source, regen command, stage), a `codegen.generated_freshness` doctor check
(manifest-based stale detection: missing manifest, schema drift, generator drift),
`codegen --explain` surface map (text or `--format json`), and a CI onboarding gate
(`bun run test:onboarding`: init → doctor → build → codegen → demo in a scratch dir).
Example bins now publish schema only; all four examples were regenerated under the
new header convention.

User-defined generic types now work at the concrete-instance level: command
`inputType`/`outputType` are pinned to the schemars `JsonSchema::schema_name`
(monomorphized names like `Wrapper_for_String`) instead of Rust's `type_name`,
which leaked invalid `Wrapper<String >` identifiers for generic payloads.
The Rust `rustra` crate ships the same minor in its own Cargo workspace release
(crates.io is manual — see docs/release-procedure.md): schema.json contract entries
change for generic and `serde_json::Value` payloads (`Value` → `AnyValue`), so the
contract hash shifts for packages using them — regenerate schema.json and TS
clients together (same minor release, per the versioning policy). CLI: friendlier
schema validation — missing config files point at `rustra init`, broken
schema.json names the file and the regen command, and generic type names get a
rebuild hint.
