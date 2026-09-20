---
'@rustra/cli': patch
---

동일 Rust 입력에 대한 반복 트리거에서 cargo 코드젠·엔진 재빌드를 건너뛰는 지문 스킵(내용 해시 기반, 실패 시 전체 파이프라인 fail-safe). `rustra dev --config` 루프가 마지막 **성공** 파이프라인 이후 감시 대상 Rust 입력(src 트리, Cargo.toml, Cargo.lock)이 바이트 동일하고 생성된 schema.json 이 살아 있으면, 해당 틱의 cargo 프로브와 엔진 재빌드를 생략합니다. 지문은 판정 시점에 디스크에서 다시 계산되며(mtime 이 아닌 내용 해시), 스킵 틱에도 패리티 게이트와 reload 훅은 기존과 같이 돕니다. 계산 실패·프로세스 시작 직후 첫 틱·schema 부재는 언제나 전체 파이프라인입니다.
