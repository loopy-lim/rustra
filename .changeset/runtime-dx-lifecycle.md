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

Development disposal cancels owned Cargo stages immediately and can be awaited
to drain active work before deleting project inputs. Wait for child output closure
and keep progress/errors on the originating session. Reload callbacks can dispose
their own watcher without joining themselves. Native Bun test fixtures build their
own library instead of relying on a previously warmed checkout.
Ignored child output cannot block verbose commands on an unread pipe.

Fix iOS JSI installation with React Native's synchronous module interop. Install
on the owning JS thread with an object-returning native method, avoiding a crash
when a Promise's void return is read synchronously. Keep the public async
installer and JS-thread teardown, and reject explicit native installation failure
before accepting a previously installed global.
