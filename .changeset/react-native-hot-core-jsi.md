---
'@rustra/react-native': minor
---

Native hot-core dev core for React Native: the adapter's C++ shell now owns a
`CoreTable` (23 C ABI function pointers, atomic release/acquire publish,
load-at-call-site) and exposes `configureHotCore` / `pollHotCoreOnce` /
`startHotCorePolling`. A swap builds the new core from the watched
`*-hot-live.*` artifact (self-contained FIPS-verified sha256 scan → unique
versioned copy → `dlopen(RTLD_LOCAL)` → symbol bind → contract-hash check,
fail-closed on empty hash → table publish); the old library handle is
deliberately leaked (never `dlclose`d). JSI HostFunctions stay owned by the
C++ shell — a swap only re-points the table, so JS rebinding and reload are
not needed (verified on Android emulator and iOS simulator: logic change
served at 5 → 105 across a single swap, no reload). Paths: Android
`<filesDir>/rustra/hot` passed by the CLI's Kotlin template
(`nativeConfigureHotCore`, debuggable builds only), iOS simulator
`RUSTRA_HOT_CORE_DIR`. Hot-swap polling has a retry cap — a byte-identical
artifact that fails 5 times poisons it — and channel handles route through the
core that owns them. Swap unit is signature-invariant logic change; generated
C++ codecs are static in the app, so contract changes must pass the CLI parity
gate (codegen) before the artifact is ever published.
