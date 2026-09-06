---
'@rustra/cli': minor
'@rustra/types': minor
'@rustra/tauri': minor
'@rustra/node': minor
'@rustra/bun': minor
---

안정화 통합: generated 헤더 형식 판정(CI 근원 수정), Tauri 이벤트 콜백 경계·채널명 Unicode 통일·payload 단일 파싱, wire batch 계약 통일(옵션·정규화·동기 throw), dispatch 중 abort 관측, native cancel 예외 분리, bootstrap 단일 슬롯 가드, EngineSupports 표면, invokeBatchSettled, profiled dispatch 등록 분리(`register`는 dispatch+batch만, 벤치 경로는 `register_profiled`).
