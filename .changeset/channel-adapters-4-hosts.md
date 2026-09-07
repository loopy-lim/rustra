---
'@rustra/tauri': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/types': patch
---

Channels on every host: the `{ handle, close() }` contract (`@rustra/react-native`
JSI is the reference) now has JS consumers on the remaining three hosts.

- **Tauri** — new `createChannel(callback, io?)` in `@rustra/tauri`: issues a
  handle via the new `rustra_channel_create` / `rustra_channel_drop` Tauri
  commands (`tauri_support.rs`, AppHandle-capture sender, no core changes) and
  delivers frames by listening on `rustra://channel/{handle}`. Delivery is
  **approximate unicast** — the channel contract is invocation-scoped unicast
  but Tauri emit is a broadcast, so a second webview listening on the same
  channel name can observe frames (single issuer = single listener is the
  normal flow). New `RustraErrorCode.ChannelUnavailable` (`channel.unavailable`)
  in `@rustra/types` covers invalid issuance across adapters.
- **Node** — new `createNodeChannel(transport, callback)` in `@rustra/node`:
  consumes the loop-stdio binary-mode reservation frames (0xfffb create /
  0xfffa drop / 0xfffc push) added to the `loop-stdio` runtime. Binary mode
  only — NDJSON transports loud-fail with `channel.unavailable`. Unlike the
  Bun FFI bridge, background-thread `send` is safe (stdout frames arrive as
  JS turn data events).
- **Bun** — new `createBunChannelBridge(options)` in `@rustra/bun`: first JS
  consumer of the existing `rustra_ffi_channel_create/send/drop` FFI symbols
  (one shared `JSCallback` trampoline with a handle→callback table). JS-thread
  send only (`threadsafe:false` contract); background sends are unsupported —
  the quiescence (`drop` blocks until in-flight callbacks return) contract is
  documented at the bridge level.
