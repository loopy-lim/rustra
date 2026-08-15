# Changelog

이 프로젝트의 주요 변경사항을 기록합니다. 세부 내역은 git history와
`docs/plans/`의 계획/결과 문서를 참고하세요.

## 0.1.1 (2026-08-14)

npm `@rustra/*` 7종(types/cli/node/bun/tauri/react-native/lynx)과 crates.io
`rustra`/`rustra-macros` 첫 공개 발행.

### Added

- rkyv V2 무직렬화 경로 (`invoke_rkyv_v2`) — JSON 대비 15~83× 작은 와이어포맷
- RN JSI fast path + C++ 코덱 (`--cpp-output`) 생성
- Lynx 어댑터 (`@rustra/lynx`) — QuickJS 런타임 지원
- codegen Map/Tuple 타입 지원
- runtime command registry / 동적 rkyv 경로
- invokeBatch (P0-2) 배치 호출
- runner 템플릿 — desktop(macOS Tauri×Lynx) + iOS + Android 플랫폼 셸,
  `create-runner.sh` 인스턴스에이션, capability 계층(File/Notify/Mobile 브리지)
- 크로스 플랫폼 검증: macOS 7/7 · iOS 7/7 · Android 7/7 스파이크 PASS
- 벤치마크: 어댑터/transport/온디바이스 실측 (iOS Direct C++ 0.95µs — Nitro 1.10µs 대비 우위)
- FFI trust hardening — 패닉 격리(catch_unwind), debug allocation tracker,
  null out_len 가드, contract hash 검증

### Changed

- 저장소 URL을 `loopy-lim/rustra` → `loopy-lim/hostra`로 정리

## 0.1.0 (2026-05-13)

초기 버전 — Rust macros(`#[command]`/`#[bridge_type]`/`build!`), codegen 파이프라인,
Node/Bun/Tauri/RN 어댑터.
