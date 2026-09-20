---
'@rustra/cli': patch
---

`rustra dev`의 cargo 스폰(스키마 generate bin, dylib 빌드)에 증분 컴파일을 기본 활성화한다 — 스폰 env로 `CARGO_INCREMENTAL=1`을 주입해 웜 루프의 cargo 단계를 단축한다(비증분 대비 대형 크레이트 약 4.4배, 2026-09-20 소비자 레이아웃 실측). 사용자가 세팅한 `CARGO_INCREMENTAL`은 항상 존중한다(rust-cache CI의 0 포함). 직접 실행하는 `cargo build`/`test`는 워크스페이스 프로필을 그대로 따르며, 증분 여부는 cargo 핑거프린트에 없어 루프 진입/이탈 시 재컴파일도 없다. 웜 루프 튜닝용 프로필 가이드(`debug = 1` + 의존성 debuginfo off)를 CLI README 에 추가했다.
