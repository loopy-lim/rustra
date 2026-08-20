---
'@rustra/types': minor
'@rustra/node': patch
'@rustra/cli': patch
---

feat: InvokeOptions.timeoutMs — 네이티브 무응답 hang의 JS 측 탈출구. 만료 시 `transport.timeout`(retryable)으로 reject 하고 지각 응답은 흡수한다(unhandled rejection 방지).

fix: 스키마 식별자 화이트리스트로 생성 TS 코드 주입 방어(name/inputType/outputType/definitions 키). napi 경로 RustraError를 JSON 와이어로 보존 — code/retryable이 소실 없이 JS까지 전달된다(기존 unknown 래핑 개선).
