---
'@rustra/tauri': minor
---

`subscribeHotSwap` subscribes to `rustra://hot-core/swapped` webview events
emitted by the Rust host's hot-core watcher (`rustra` ≥0.9
`tauri_support::register_dispatch_with_swap_events`). Each payload carries the
old/new contract hashes, so JS caches can decide whether to refetch generated
metadata without a separate generation counter. Reported for both successful
and failed swaps; the reporter lives on the host side and therefore survives
core swaps (which drop in-core state by design).
