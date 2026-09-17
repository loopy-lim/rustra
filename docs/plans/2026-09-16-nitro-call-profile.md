# Nitro 공통 호출 프로파일과 후속 개선

> **For agentic workers:** Use subagent-driven-development with task reviews. Parent owns native builds, profiling and timing.

**Goal:** 승인된 공통 호출 경로 → 큰 트리 → 버퍼 순서로 실제 CPU 병목을 확인하고, 관찰로 지지되는 일반 개선을 적용·재검증한다.
**Architecture:** 고정된 현재 Release 후보에서 별도 프로파일 모드로 한 작업을 실행한다. 원래 v2 벤치마크는 변경하지 않는다. 프로파일은 병목 위치만 판단하고 시간 개선은 프로파일 없는 전후 대조와 공개 v2로 검증한다.
**Tech Stack:** RN 0.81.5, Nitro/nitrogen 0.37.1, Hermes, Rust/C++ JSI, iOS Simulator and Android physical.
**Spec:** [기존 비교 계약](../specs/2026-09-16-nitro-parity.md), [승인된 다음 조사 지점](../research/2026-09-16-nitro-parity-followup.md).

## Global Constraints

- Base c3bed5dc; 기존 isolated nitro-parity worktree. 이전 원본·기각 후보 보존.
- 동일 입력/정답/소유권/알고리즘, 호출 세대·재진입·오류·payload·same-core invoke/free 보존.
- 프로파일 별도 rustra-nitro-profile/v1, v2 합격 기준·순서 불변. 통계에서 느린 표본 제외 금지.
- 무작위·fuzz·스트레스 테스트 추가 없음. 고정 입력의 최대15초 CPU 관찰만 수행.
- 부모만 빌드·기기·프로파일·측정. 성능 창 동안 다른 CPU 집약 작업 금지. 전용 com.rustra.nitroparity만 사용.
- 새 버전·발행·push 없음. 기존 승인에 따라 검증된 변경을 로컬 커밋.

## Task 1: Actual public-call profiling harness

**Files:** RN src/nitro-parity/profile.ts, profile-run.ts, profile.test.ts, NitroParityApp.tsx; scripts/run-nitro-profile-ios.ts.
**Interfaces:** profile config fixes case/framework/runId/duration; real createCases and public bindSync route; profile receipt carries iterations/checksum/config/source identity and explicitly non-benchmark timing.

- [ ] Deterministic tests: strict config allowlist/bounds, synchronous result, exact consumed result checksum, finite loop deadline and no async calls inside loops.
- [ ] Add explicit EXPO_PUBLIC_PARITY_PROFILE=1 entry; original v2 and prior buffer v1 unchanged.
- [ ] Reuse all existing case preflight checks before a selected single-framework CPU observation. Log READY once, allow collector attach, then bounded CPU loop, write separate-protocol receipt.
- [ ] Parent collects selected string/pair/indexed and large-tree profiles, beginning with one pilot. Authenticate executable/JS hashes and preserve raw profile/receipt. Never infer percentage from unrelated process threads.
- [ ] Review harness and interpretation before selecting production candidate.

## Task 2: Source-backed improvement decision

- [ ] Rank observed hot stacks against C++ result creation, Rust framed dispatch/state context, and tree conversion. Record pre-existing optimizations to avoid retrying resolved costs.
- [ ] Select one repeated generic cost only when profile or a isolated production-path control supports it. Write its exact change and regression cases into the execution ledger before editing runtime.
- [ ] Implement candidate with deterministic contract checks; compare same inputs/current vs candidate without profiler. Reject and restore if slower or unproven. No removed guard or benchmark-only algorithm shortcut.

## Task 3: Evidence and integration

- [ ] If candidate retained, freeze sources/binaries and run original five-launch v2 per available platform. Report all public counts and absolute gaps; do not claim full parity unless proven.
- [ ] Update research/receipts/plan with raw profile correspondence, limitations, accepted/rejected decisions and remaining work.
- [ ] Independent final review, appropriate checks, scoped local commits, clean worktree; retain raw evidence.
