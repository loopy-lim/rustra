# G0 성능 기준선 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M0 안전성 수정이 재귀 complex codec과 기존 비재귀 경로에 미친 비용을 같은 조건의 A/B 영수증으로 남기고, 이후 회귀를 CI에서 감지한다.

**Architecture:** 기존 `complex_route` Criterion 벤치에 재귀 명령을 추가해 실제 `Package::invoke_frame` 경계를 측정한다. 기준 SHA와 후보 작업 트리를 같은 macOS arm64 환경, 같은 Rust toolchain, release profile에서 각각 독립 프로세스 5회 실행하고 원본 Criterion 결과와 요약 JSON을 보존한다. 기존 oneOf/map은 control로 유지해 재귀 Value fallback의 비용과 공통 경로 회귀를 구분한다.

**Tech Stack:** Rust 1.98.0, Criterion 0.8, Bun 1.4.1, Git worktree, GitHub Actions

**Spec:** `docs/specs/2026-09-14-rustra-roadmap.md`

## Global Constraints

- 공개 wire/FFI/API 계약을 바꾸지 않는다.
- 기준판과 후보판은 동일 기기·OS·도구·빌드 프로필·입력으로 비교한다.
- 각 판은 독립 프로세스로 최소 5회 실행한다.
- 재귀 경로의 안전성 수정은 유지하며, 성능 때문에 강한 `Arc` 순환을 되돌리지 않는다.
- 10%를 넘는 비재귀 control 회귀는 원인을 설명하거나 수정한 뒤 수용한다.
- Tauri/RN 실기기와 실제 소비자 수치는 이번 로컬 코어 기준선으로 대체하지 않는다.

---

### Task 1: 재귀 complex route 측정면

**Files:**

- Modify: `crates/rustra/benches/complex_route.rs`
- Create: `scripts/benchmark-workflow.test.mjs`
- Modify: `.github/workflows/bench.yml`

- [x] 재귀 linked node 명령의 depth 1·8 wire smoke와 Criterion case를 추가한다.
- [x] Benchmark workflow가 `complex_route`를 실행하고 로그 요약에 포함하는 실패 테스트를 먼저 추가한다.
- [x] 테스트 실패를 확인한 뒤 workflow를 연결한다.
- [x] 벤치가 실제 `Package::invoke_frame` 응답 바이트를 검증한 뒤 측정하는지 확인한다.

### Task 2: 동일 조건 A/B 수집

**Files:**

- Create: `docs/benchmark-receipts/2026-09-14-m0-complex-route-ab.json`

- [x] 기준 SHA `b1ed9aa422fb4e627131f02f67de9f50bdbfedf7`의 임시 worktree에 같은 benchmark 파일을 적용한다.
- [x] 분리된 `CARGO_TARGET_DIR`과 release profile에서 기준판을 독립 프로세스 5회 실행한다.
- [x] 후보 작업 트리를 독립 프로세스 5회 실행한다.
- [x] 각 case의 Criterion median estimate, 5회 분포, 변화율, 환경, 명령, 소스 식별자를 JSON에 보존한다.
- [x] 비재귀 control이 10%를 넘게 느려지면 원인을 수정하고 A/B를 다시 수집한다.

### Task 3: 현재 성능 범위와 다음 병목 기록

**Files:**

- Modify: `docs/benchmarks.md`
- Modify: `docs/benchmarks.ko.md`
- Modify: `docs/verification/2026-09-14-m0-safety-release.md`
- Modify: `docs/specs/2026-09-14-rustra-roadmap.md`

- [x] A/B 수치와 안전성/성능 trade-off를 EN/KO에 기록한다.
- [x] 코어 microbenchmark, host, 실제 소비자, 실기기를 서로 다른 증거 수준으로 표시한다.
- [x] 성능 개선 주장은 측정치가 뒷받침하는 범위로 제한한다.
- [x] G0에서 새로 닫힌 항목과 여전히 미측정인 온보딩·실사용 지표를 구분한다.

### Task 4: 최종 검증

- [x] 새 workflow 테스트와 관련 Rust 테스트를 실행한다.
- [x] `complex_route`를 fresh process로 다시 실행한다.
- [x] 기존 Criterion 회귀 판정 테스트와 전체 diff 형식을 확인한다.
- [x] 영수증의 SHA·환경·case 수·5회 반복·원본 경로를 검증한다.
