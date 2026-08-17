---
'@rustra/react-native': minor
'@rustra/types': minor
---

이벤트 푸시 API — `subscribeEvent(native, name, cb)` → unsubscribe (RN JSI
`onEvent`/`offEvent` 위 래퍼, 페이로드는 TS 에서 `JSON.parse` 1회 복원).
`RustraNative` 타입에 `onEvent`/`offEvent`/`drainEvents` 선택 필드 추가.

Rust 쪽(`rustra` 0.1.2)은 crates.io 수동 발행 대상이라 changeset 에 넣지
않는다 — `Package::set_event_sink`, `tauri_support::register_with_events` /
`tauri_event_sink` / `event_channel`, FFI `rustra_ffi_event_sink_register` 참고.
