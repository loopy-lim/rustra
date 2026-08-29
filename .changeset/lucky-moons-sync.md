---
'@rustra/types': minor
'@rustra/bun': minor
'@rustra/react-native': minor
---

Expose the live schema generation for dev substitution re-sync: native bindings surface `rustra_ffi_schema_generation` (u64 LE) and `schemaGeneration` in the live schema JSON, and the TS engine adds an opt-in generation gate that re-syncs the stale dynamic-command cache when the native registry mutates (register/replace/unregister). Hosts that do not expose the generation symbol keep the previous cache behavior.
