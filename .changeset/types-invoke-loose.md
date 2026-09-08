---
'@rustra/types': minor
---

Adds `invokeLoose(client, command, args?, options?)` — the official surface for
calling a Rust handler registered at runtime on a debug build, before (or
without) running codegen. It is a named delegation to the engine's name-based
`invoke`, so the usual codec fast-path → live schema commandId lookup →
tier-3 JSON fallback chain decides how the call is served, and the result
type defaults to `unknown` for the caller to narrow. Promote to static
typing with `rustra codegen` as usual.
