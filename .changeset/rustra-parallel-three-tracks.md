---
'@rustra/types': minor
'@rustra/testing': minor
'@rustra/devtools': minor
'@rustra/react': minor
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
---

Three parallel tracks landed together.

**Events surface complete**: `subscribeEvent` now exists on every host — Node (`drainEvents` polling adapter), Bun (`createBunEventBridge`: FFI push sink with polling fallback), joining Tauri and React Native. Signatures are pinned to the codegen `SubscribeFn` contract by compile-time probes.

**Performance five tracks**: complex-route core dispatch stops rebuilding `serde_json::Value` trees three times per call (schema IR precompilation + direct serde), dynamic commands gain a `schema_generation` replacement contract and a postcard fast-path (472–488 ns vs 4.7 µs Tier 3), the Node persistent loop speaks binary framing, Tauri gets batched `rustra_dispatch_batch` and corrected IPC measurements (246 µs with a 709 ns native component), and RN async dispatch enters by command id.

**Developer experience**: the CLI has one shared arg parser (`--help`, exit codes, `--flag=value`, "did you mean" suggestions), refuses to overwrite existing files on `init` without `--force`, fails loudly on unknown config keys, and reports codegen `unknown` fallbacks as warnings. `RUSTRA_DEBUG=wire` dumps wire bytes; errors preserve `cause` and distinguish `TimeoutError`/`CancelledError`. Six documentation examples that failed to compile or run were corrected, and the changelog covers 0.3 → 0.5.

`@rustra/types` is minor: testing/devtools/react 0.4.1 already require `^0.5.0`, so this release realigns all packages at one version.

Rust crates (`rustra`, `rustra-macros`): schema generation contract for hot-replace sync, dynamic-command postcard handlers, Tauri `rustra_dispatch_batch`, precompiled complex-codec IR, direct serde encoding, and codegen warning collection surfaced on `GeneratedPackage.warnings`.
