---
'@rustra/cli': minor
---

The `reactNative.legacyBenchmarks` config key is removed, along with the
`RUSTRA_LEGACY_BENCHMARKS` / `RUSTRA_ENABLE_LEGACY_BENCHMARKS` build flags from
generated modules. `rustra init` scaffolds now write `schema.json` only
(`write_schema_to_dir`) instead of the stale dual pass that also regenerated
TS surfaces from Rust.
