---
'@rustra/cli': patch
---

schema.json 부재 시 Node 원문 ENOENT 대신 재생성 힌트를 노출한다 — generate·codegen·diff·dev 패리티 캡처 전 경로에 "Schema file not found: <경로>. Run the Rust contract probe first ..." 형태의 실행 가능 메시지로 통일하고, generate 서브커맨드 헬프에 탑레벨과 동일한 --watch 항목을 보강한다.
