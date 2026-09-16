# 0.10.2 Performance Patch Implementation Plan

**Goal:** 0.10.1 안전성 수정을 유지하면서 측정된 codec 비용을 줄이고 0.10.2로 발행한다.
**Architecture:** Weak IR + codec 소유 재귀 대상 테이블, 빌드 시 지원 판정, 직접 serde 입출력.
**Tech Stack:** Rust, serde, Criterion, GitHub Actions, Node registry audit.
**Spec:** [성능 패치 SPEC](../specs/2026-09-16-patch-performance.md)

## Global Constraints

공개 API/wire/FFI 불변. strong Arc cycle 금지. 기존 스키마 fallback·입력 제한 유지. 사용자 작업 및 다른 worktree 미수정. 결과가 없는 최적화는 포함하지 않는다. 동일 기기에서 시간 측정은 직렬 실행한다.

## Task 1: 재현 및 벤치 확대

- [x] main 0.10.1에서 complex_route 기준 실행: 깊이 1 약 0.83 µs, 깊이 8 약 4.56 µs.
- [x] `crates/rustra/benches/complex_route.rs`에 깊은 재귀, optional payload, 넓은 struct 대표 경로와 사전 바이트 검증 추가.
- [x] 별도 할당 계측 실행 경로를 추가하고 시간 측정과 분리.
- [x] 기준판·후보판에 같은 벤치 소스를 사용한다.

## Task 2: codec 최적화와 회귀 검사

- [x] direct 재귀 실패를 보여주는 테스트를 먼저 실행한다.
- [x] `complex_serde_*`, `complex_codec_encode_object.rs`에 컴파일 시 대상 소유 및 adapter 참조 전달을 구현한다. 필요하면 작은 내부 모듈로 분리한다.
- [x] 강한 순환 없음, 상호재귀/enum/seq/map, Value 경로 바이트 동등성 및 제한 오류 테스트 추가.
- [x] optional 버퍼 제거와 다음 필드 탐색 fast path를 추가하고 기존 wire 및 실패 계약을 검사한다.
- [x] 재귀 명령의 입력·출력 쌍에 호환 재시도를 공유하고 nullable/flatten/typed map 키/const/handler 단일 실행을 검사한다.
- [x] 작은 map의 중복 키 검사를 할당 없이 처리하고 큰 map 예약을 64개로 제한한다.
- [x] sequence 용량 힌트는 남은 입력으로 제한하고 큰 선언 길이의 잘린 입력을 검사한다.
- [x] 기존 `invoke_complex_serde` fuzz에 재귀 입력 및 caller-buffer 경로를 추가한다.
- [x] `cargo test -p rustra --lib --locked`, 관련 통합 테스트, fmt/clippy 및 아키텍처 한계를 검증한다.

## Task 3: 동일 환경 전후 비교 및 문서

- [x] 독립 실행 각 5회 교차 측정. 후보 개선과 대조군 10% 예산을 평가한다.
- [x] 할당 횟수 비교 및 실제 입력 크기·SHA·환경·hash·분포를 JSON receipt에 기록한다.
- [x] SPEC/PLAN/benchmarks 문서에 실제 결과와 미측정 경계를 반영한다.

## Task 3b: 분기 트리와 탐색 검증

- [x] 같은 복합 노드 타입으로 균형/넓음/편향/큰 payload fixture와 노드 수·바이트 검증 추가.
- [x] echo/전체 입력 DFS 요청/보관된 트리 ID 조회/순수 DFS를 분리하고 기본 깊이 한도 초과 거부 확인.
- [x] 독립 프로세스 각 5회 비교와 별도 할당 계측. 시간 증가를 노드 수·payload와 함께 해석.
- [x] 전체 트리 전송과 탐색 결과만 반환하는 사용 패턴의 비용, 한계와 결과를 문서화.

## Task 4: 0.10.2 발행

- [x] crate 버전, lockfile, changelog, 설치·호환 문서 갱신.
- [x] 독립 코드 검토 후 nullable/flatten/typed map/const 및 입력·출력 쌍 호환성 수정. 최종 검토 차단 사항 없음.
- [ ] 한국어 Conventional Commit으로 커밋.
- [ ] PR/CI를 통과시켜 main으로 통합한다.
- [ ] 같은 SHA의 Miri/Sanitizer/Fuzz를 거친 정식 Release로 Rust crate 3개 발행.
- [ ] 레지스트리 버전·VCS SHA·checksum·yanked 상태 확인 후 보고.
