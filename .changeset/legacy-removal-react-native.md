---
'@rustra/react-native': minor
---

The JSI host object drops the calculator-only legacy benchmark functions
(`invokeBytes`, `invokeMsgpack`, `invokeBincode`, `invokePostcard`,
`invokeLegacyPostcard`, `invokeRkyv`, `invokeHybrid`, `invokeRaw`). Defect fix:
`invokeRkyvV2` is now registered outside the legacy ifdef and binds to the core
generic symbols (`rustra_ffi_invoke_rkyv_v2` + `rustra_ffi_free`), so
legacy-OFF builds no longer crash the engine's tier-2/3 fallbacks.
