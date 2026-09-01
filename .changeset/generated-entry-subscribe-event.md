---
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
---

Generated `node.ts`/`bun.ts` host entries now export `subscribeEvent` when the
schema declares events — same one-line import surface as the RN/Tauri entries.
New adapter factories back it: `createBunEventSubscription` (`@rustra/bun`)
resolves the cdylib with the exact same candidate computation as the bootstrap
(`RUSTRA_BUN_LIBRARY` included), keeps the synchronous
`(name, callback) => unsubscribe` signature by queueing subscribers until the
FFI bridge (with polling fallback) is ready, and fails fast on initialization
failure; `createNodeEventSubscription` (`@rustra/node`) lazily spawns an event
transport resolved like the bootstrap and delegates to the existing polling
`subscribeEvent`. Schemas without events keep byte-identical entry output.
