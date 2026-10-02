---
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
'@rustra/cli': minor
'@rustra/types': patch
---

Keep generated commands and events on the same selected runtime. Add persistent
Node configuration for stateful applications, strict Tauri contract verification,
and producer-bound React Native channel cleanup. Normalize malformed batch errors,
preserve decoded Tauri string payloads, and close transport and subscription
lifecycle gaps. Development watching now tracks Cargo workspace/path dependencies,
build scripts, compiler dep-info, Cargo configs and toolchain selection. Config and
legacy dev exclude owned generated files without hiding adjacent source, including
overlapping Cargo target directories, and stop pending publication after disposal.
Keep one-field generated commands and their generation-aware factory helper
together. The React Native shell and Rust core retain the optional owned-response
handoff with the legacy overflow fallback.
