---
'@rustra/node': patch
'@rustra/bun': patch
'@rustra/react-native': patch
'@rustra/tauri': patch
'@rustra/cli': patch
---

Make setup failures actionable: resolve Node runtime candidates from the selected
child cwd, explain Bun FFI's runtime requirement, validate the selected React Native
native transport before readiness, and preserve structured bootstrap errors.
Tauri missing-registration errors now explain handler replacement and command
composition. Doctor checks compatible runtime versions and host-specific native
tools while allowing the Node process adapter to run under Bun.
