---
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/devtools': minor
'@rustra/tauri': patch
'@rustra/testing': patch
'@rustra/react': patch
'@rustra/react-native': patch
---

Behavior-preserving cleanup pass (Rust side): the serde struct/variant
serializers share one core (`complex_serde_ser_core`), `register!`/`build!`
expand to the same `PackageBuilder` command chain, and the command
function-name rule lives in `rustra-naming::snake_to_lower_camel`.

No wire-format or error-message changes.
