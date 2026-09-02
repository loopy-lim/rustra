---
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
---

0.6 완성도 트랙 — `rustra diff` 이벤트 게이트(event_removed/event_payload_changed,
이벤트 추가는 non-breaking), Node 푸시 이벤트(0xfffd 프레임 + 능력 재판정 폴링
폴백, 2-모드 dispatch), Bun FFI 이벤트 브릿지 자동배선, 생성 엔트리
subscribeEvent export(node/bun, 이벤트 없으면 바이트 불변), `codegen`/`diff
--format json`, UsageError exit-2 계약, docs 동기화 게이트(test:docs + CI).
