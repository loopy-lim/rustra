---
'@rustra/tauri': minor
'@rustra/react-native': minor
---

Removes the deprecated legacy `subscribeEvent` overloads (deprecated in 0.6.0; the one-minor deprecation policy requirement is satisfied). `@rustra/tauri` now accepts only `subscribeEvent(name, callback[, listen])`, and `@rustra/react-native` accepts only `subscribeEvent(name, callback[, options])` with the native module resolved from `globalThis.__rustraNative`.
