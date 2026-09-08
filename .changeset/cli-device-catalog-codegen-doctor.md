---
'@rustra/cli': minor
---

`rustra codegen` now emits `devices.ts` — a device token union plus
required-capability constants per command — single-sourced from the schema's
`deviceCapabilities` catalog instead of a hand-maintained mirror (tokens
outside the catalog render with dev markers). `rustra doctor` gains a
`codegen.device_catalog` check that walls off out-of-catalog device tokens
before release: `skip` when no command declares devices, `warn` when the
schema lacks the catalog (regenerate with a current rustra), and `fail` when
declared commands use tokens the catalog does not know — release builds of
the Rust engine panic on such tokens at registration time, so the check
surfaces them earlier from the JS side.
