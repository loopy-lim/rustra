---
'@rustra/cli': minor
'@rustra/types': minor
'@rustra/node': patch
'@rustra/tauri': patch
---

Generate positional TypeScript clients for ordinary Rust functions registered with
`PackageBuilder::function` and `try_function`. Support zero through twelve arguments,
plain and unit returns, and explicit domain-error mapping without a Rustra command macro.

Align root tuple/scalar/collection binary codecs with Rust, preserve unit return values,
and reuse cursor request encoding and Rust caller-provided response buffers. Function
commands use the verified binary fallback when native static codecs do not support
their root shape. Use matching Rust development source until the coordinated release.

Reuse exact transport buffers for stable-length frame requests and isolate buffers
during synchronous reentry. Positional facades preserve ordinary function wrappers.
