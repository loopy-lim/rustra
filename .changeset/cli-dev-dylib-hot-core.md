---
'@rustra/cli': minor
---

`rustra dev` gains `dev.target: "dylib"` — an experimental native hot-core dev
loop. The Rust core is built as a cdylib and the running host swaps it without
restart (the host is launched with the `RUSTRA_HOT_CORE` artifact path; see the
tauri-calculator example). The schema parity gate that guards wasm reloads now
also guards dylib swaps, fail-closed: builds land on a scratch cargo target
path, and only a gate-passing build is published — via temp-file + atomic
rename — to the `<stem>-hot-live<ext>` path the host watches. A gate rejection
leaves the previously published core untouched; before the first successful
publish nothing is written, so the host must not be launched. New config keys:
`dev.target: "native" | "wasm" | "dylib"` and `dev.dylib.parityGate`
(default `true`).

Generated apps now require `rustra` ^0.9.0 (crate) and
`@rustra/react-native` ^0.8.0 (`rustraTemplate` ranges updated): the RN
Android template passes a `filesDir` hot-core path via
`nativeConfigureHotCore` (debuggable builds only — release builds never gain
an appdata dlopen surface), which needs the adapter's hot-core native
surface.
