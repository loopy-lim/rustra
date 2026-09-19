---
'@rustra/types': minor
---

RustraErrorCode에 누락된 Rust 발급 코드 2개 상수를 추가한다 — `SignatureMismatch`('signature.mismatch', registry.rs replace 와이어 시그니처 가드)와 `InvokeBackpressure`('invoke.backpressure', 비동기 FFI 워커 큐 포화). 전체 레퍼런스는 docs/error-codes.md(29개 코드)를 참고.
