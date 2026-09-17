# Nitro 잔여 성능 개선 실행 계획

> **For agentic workers:** Use subagent-driven-development with task reviews; parent owns native builds and timing.

**Goal:** 남은 Nitro 성능 차이를 원인별로 검증하고, 계약을 보존하는 개선을 채택해 공개 경로에서 다시 측정한다.
**Architecture:** 기존 원본 보존 → 버퍼 순서/분리 진단 → 작은 호출 공통 경로·DFS 비용의 독립 가설 검증 → 채택 후보의 동일 조건 재측정.
**Tech Stack:** Rust, C++ JSI, TypeScript, Hermes Release, RN 0.81.5, Nitro/nitrogen 0.37.1.
**Spec:** [기존 Nitro parity spec](../specs/2026-09-16-nitro-parity.md), [승인된 잔여 분석 및 실험 설계](../research/2026-09-16-nitro-parity-gap-analysis.md).

## Global Constraints

- Worktree `/Users/loopy/dev/ll3/rustra-bridge/.worktrees/nitro-parity`, base `ae30d764`; preserve existing uncommitted analysis.
- Same inputs, fresh outputs, ownership, algorithm, setup/index replacement policy; preserve payload limits, generation/reload/dispose, getters/reentry, same-core invoke/free, Promise cancellation/timeout.
- Keep Nitro/nitrogen 0.37.1, RN 0.81.5 and Hermes fixed. Diagnostic protocols have separate IDs and never overwrite v2 receipts or acceptance rules.
- Parent owns all native builds, installs and timing. No concurrent performance measurement or CPU-heavy work during timing; dedicated app `com.rustra.nitroparity` only.
- No new fuzz/randomized/stress tests; use ordinary deterministic correctness tests and bounded performance comparisons.
- No publication, push or version changes. Source identity and native/JS artifact hashes accompany results. No full parity claim unless measured.
- Existing 300 archived aggregates remain immutable. Format before freezing measured sources.

## Task 1: Buffer cause separation

**Files:** new RN `src/nitro-parity/diagnostic*.ts` and tests, dedicated diagnostic runner/collector as necessary; `NitroParityScreen` entry only for explicit diagnostic mode.
**Interface:** Separate `rustra-nitro-diagnostic/v1` receipt with case ID, framework, schedule, fingerprint, runId and raw samples. Frozen schedules: rustra-only, nitro-only, alternating AB/BA with 31 measured rounds and 3 warmups. No forced GC or reduced memory reporting.

- [x] Test schedule coverage/order, output consumption/freshness and receipt identity rejection before implementation.
- [x] Add diagnostic protocol using the real public sync binding and real Nitro methods for 65536 and1048571 byte buffers. Keep original v2 runner unchanged.
- [x] Freeze unchanged-runtime diagnostic sources; run Android bounded independent launches with each schedule, capture raw results and artifact identity; validate on iOS when it distinguishes the cause.
- [x] Determine whether order moves the slow work, whether isolation preserves the gap, and whether runtime GC counters are available. State correlation vs causality explicitly.
- [x] Task review of correctness and result interpretation.

## Task 2: Fixed call overhead

**Files:** `packages/types/src/global-sync.ts`, `frame-engine-sync.ts`, context/state types and existing sync tests; C++/codegen only after a measured reason.
**Interface:** Existing `bindSync<I,O>(command): (input:I)=>O` remains unchanged.

- [x] Audit exact guarded hot path; prepare one minimal generic closure-fusion candidate, with baseline file copies and changed mechanism explanation.
- [x] Run existing generation/reconfiguration/getter/reentry/error/disposal tests and add only missing behavior tests needed by the change.
- [x] Parent compares same native binary + old/new JS bundle on small public cases; retain all runs and reject regression. Original full v2 acceptance is assessed separately.
- [x] If fixed JS cost is not material, measure native codec dispatch selection before changing it; explicitly reject unsupported speculation.
- [x] Task review; retain only a verified candidate.

## Task 3: Core DFS and large conversion diagnosis

**Files:** focused benchmark drivers under `scripts/` or task scratch, existing Rust `examples/calculator/src/parity_bench.rs` and Nitro C++ fixture as exact source inputs. Runtime changes only if supported by observations.
**Interface:** Same balanced255/1023/8191 and wide1025 data, visit count, lock/stack/name-copy policy; core-only numbers are diagnostic and cannot replace public comparison.

- [x] Inspect optimized data layout and the exact Rust/C++ traversal to rank falsifiable causes; do not change algorithms to make a benchmark pass.
- [x] Build a reproducible core-only comparison from current source, including actual type sizes and stack growth counts outside timing; compare same host architecture and compiler optimization settings.
- [x] Test one supported general optimization if found; preserve indices/bounds/ownership and correctness. Fixture-only improvements are labeled separately.
- [x] Inspect large DTO and async costs; select changes only when a concrete repeated cost and testable safe replacement exist. Record rejected candidates.
- [x] Task review of source correspondence and claims.

## Task 4: Final evidence and integration

**Files:** prior analysis, new follow-up report/receipts, SPEC/PLAN links; only accepted runtime diffs.

- [x] Run relevant correctness/type/codegen/architecture checks for final changed paths.
- [x] Freeze formatted final source, installed native inputs, binary and bundle hashes; run five independent iOS and Android launches where available, no parallel CPU work.
- [x] Publish all 30 operations ×3 lanes per platform in local receipts, accepted/slow/inconclusive counts, comparison limitations, platform scope and rejected hypotheses.
- [x] Independent final review, concrete commit grouping and local commits within user authorization. No push/publish.

## 실행 결과와 계획 조정

1. Task 1은 Android의 40개 독립 진단·1,860개 표본으로 완료했다. iOS 순서 효과와 샘플별 GC 인과성은 미검증으로 명시했다. 진단은 별도 v1이며 기존 v2 판정을 교체하지 않는다.
2. Task 2의 클로저 후보는 재설정 후 손해 때문에 적용·기기 A/B 전에 기각했다. 사전 확정된 command 조회는 이미 빌린 정적 항목을 사용했다. 보호 경계 삭제나 새 ABI는 채택하지 않았다. 이는 코드 변경을 강행하는 대신 승인된 채택 기준에 따른 기각이다.
3. Task 3의 host core 재현은 동일 호스트의 최적화 빌드에 한정하며 동일 컴파일러라는 가정은 철회했다. 원본 시간 측정과 별도 실제 용량/stack 관찰을 보존했다. 큰 출력의 두 후보는 느려서 복원했다. 일반 작은 맵 후보는 140개 인코더 대조 프로세스 및 전체 앱 재검증을 수행했다.
4. 최종 소스317개·설치 입력205개를 고정하고 iOS/Android 각5회×90항목을 완료했다. 공개 동기40/60, Promise API39/60 동급 이상이며 전체 목표는 미달이다. [전체 결과](../research/2026-09-16-nitro-parity-followup.md).
