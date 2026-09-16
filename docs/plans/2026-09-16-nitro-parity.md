# Nitro Parity Implementation Plan

**Goal:** 작은 호출, 복합 트리, 반복 탐색을 개선하고 동일 조건의 Nitro 0.37.1과 비교한다.
**Architecture:** 고정 버전의 동등 native benchmark → 병목 기반 JS/JSI 및 Rust codec 개선 → 공개 소비자 경로 재측정.
**Tech Stack:** Rust, TypeScript, C++ JSI, Nitro/nitrogen 0.37.1, Hermes, React Native 0.81.5, Criterion.
**Spec:** [2026-09-16-nitro-parity.md](../specs/2026-09-16-nitro-parity.md)

## Global Constraints

- Baseline `8db7279cd30cf50ab1ba625f325a11a832697891`; worktree `codex/nitro-parity` only.
- Nitro runtime and nitrogen exactly 0.37.1. Do not change React Native/Hermes during A/B.
- Same inputs, outputs, ownership, algorithm, storage/index policy for both competitors.
- Synchronous timings have no Promise/await; public async and internal diagnostic routes are separate.
- Five independent launches; equivalent ±5% CI or better; no selective winner claims.
- Keep wire/FFI, payload/depth limits, engine-generation checks, cancellation/timeout of existing APIs, single handler execution and leak safety.
- Parent owns native builds/device setup and timing. No concurrent timing or CPU-heavy build during measurements. Preserve all other worktrees and installed user apps.
- New source modules target <=400 lines. Regenerate generated files. No unrelated refactors.
- Do not publish or modify release versions as part of benchmark setup.

## Task 1: Reproducible native comparison

**Files:** RN example package/lockfile and Nitro fixture; new `src/nitro-parity/*`; benchmark entry point and receipt scripts/tests; calculator benchmark fixture modules and generated bindings as needed.
**Interfaces:** Self-contained parity mode selected by `EXPO_PUBLIC_RUSTRA_DEMO=nitro-parity`; JSON receipt `rustra-nitro-parity.json` via existing native receipt writer or explicit matching filename; no UI interaction required.

- [x] Pin root RN example and Nitro module runtime/generator to 0.37.1; regenerate Nitro bindings with that exact generator. Parent installs/builds.
- [x] Add independently verified small-operation sync and async lanes; sync Rustra native route is explicitly diagnostic until Task 2's public binding is available.
- [x] Pilot recursive Nitro DTO generation. Prefer recursive data if supported; otherwise use identical flat arena nodes on both sides and document why.
- [x] Add balanced 255/1023/8191 and wide1025 fixtures with echo, full-input DFS, resident DFS, indexed lookup, setup/update timing; exact parity tests before time measurement.
- [x] Unit-test shape/result checks and statistical gate with synthetic fixtures that include slow/ambiguous/mismatched samples; runtime performance must never be inferred from those tests.
- [x] Receipt includes contract/version/fingerprint and lane labels; collector rejects stale/incorrect/unsupported results. Add a reproducible driver and keep legacy receipts separate.
- [x] Parent builds a dedicated benchmark application, runs baseline repetitions and stores raw receipts before changing runtime.

## Task 2: JS and native call overhead

**Files:** `packages/types/src/frame-engine-*.ts`, public types/exports and focused tests; Rust command registration/schema and macro execution metadata; CLI schema/codec metadata generation; benchmark public-lane wiring.
**Interfaces:** Prefer an explicit `FrameEngine.bindSync<I,O>(command: string): (args: I) => O` if profiling supports it. Resolve/validate once but invalidate on generation change. Existing Promise API remains unchanged.

- [x] Record hypotheses from actual baseline lane breakdown; write failing tests for the selected behavior.
- [x] Implement measured overhead reduction and a safe synchronous public binding when necessary. Reject unsupported/async command behavior explicitly; do not use internal symbol access in user examples.
- [x] Preserve original macro asyncness as producer-side execution metadata through registration, live/contract schemas and generated codecs. Legacy/unknown commands remain usable through existing APIs but cannot bind synchronously. Replacing a command must not inherit stale eligibility.
- [x] Validate native contract and live generation for the new binding; fail closed on missing/stale metadata. Measure the complete guarded route, including generation checks.
- [x] Test unknown/mismatched IDs, stale schema generation, throwing handler, payload limits, reentrancy, and preservation of existing async options.
- [x] Compare candidate against frozen baseline and Nitro, retaining only verified improvements.

## Task 3: Complex tree allocations and data lifetime

**Files:** CLI C++ codec generators and native lifetime tests; Rust complex codec modules and focused tests/benchmarks; parity fixtures/native lifetime implementations where needed.
**Interfaces:** Existing codec/handler API and wire unchanged; tree ownership/index behavior identical in Rust and Nitro.

- [x] Profile 0.10.2 tree allocations and locate repeated work with a reproducible release driver.
- [x] Form ranked, falsifiable hypotheses; change one mechanism at a time with behavior tests first.
- [x] Prioritize measured arena costs in generated C++ property/key conversion. The arena uses postcard; the earlier recursive complex map allocation target is a separate control and cannot explain these native timings.
- [x] Reduce confirmed allocation/interpreter costs without weakening validation or adding strong cycles.
- [x] Measure setup/update plus resident DFS/index behavior separately, include missing IDs and replace/update correctness.
- [x] Repeat core controls and actual RN complex lanes; drop regressions or report remaining target gaps explicitly.

## Task 4: Final validation and evidence

**Files:** SPEC/PLAN, benchmark docs, versioned receipts, focused consumer example and task report.

- [x] Independent code/spec review per implemented task, fixes and covering tests.
- [x] Final same-source repeated iOS Release runs; physical Android check with dedicated app if supported; keep platform conclusions separate.
- [x] Relevant Rust/TS/C++ suites, typechecks, generated freshness, API snapshot and documentation validation.
- [x] Record all case results and confidence classifications, hardware/runtime/source identities, memory allocation and setup costs, remaining unsupported surfaces.
- [x] Korean Conventional Commits; no claim of Nitro parity for cases without equivalent measured evidence.
- [ ] Reviewable PR — follow-up after the local commit and analysis phase.

## 진행 증거 — 2026-09-16

기준판은 iOS Simulator와 물리 Android에서 각각 5회 측정을 마쳤다. 공개 동기 API와 Rust 코덱 개선은 구현·단위 검토를 마쳤다. 최종 후보는 소스314개·설치 입력205개와 바이너리를 고정한 뒤 iOS와 Android에서 각각5회×90항목의 정답과 결과를 확보했다. 공개 동기30항목 중 iOS18개·Android19개가 동급 이상이며 전체 목표는 미달이다. 구현 및 반복 측정 단계의 완료와 전 항목 성능 목표를 구분한다. 구현·벤치마크·문서를 3개 로컬 커밋으로 정리했다. PR과 발행은 후속 단계다.

- [최종 후보 전체 결과와 남은 차이](../research/2026-09-16-nitro-parity-candidate.md)
- [동일 조건 Nitro 기준판](../research/2026-09-16-nitro-parity-baseline.md)
- [작은 map 및 응답 버퍼 개선](../research/2026-09-16-codec-scratch-and-frame.md)
- [정수 배열 개선과 채택하지 않은 실험](../research/2026-09-16-integer-sequence-optimization.md)
- [공개 동기 API의 사용 조건](../synchronous-bindings.md)

추가 스트레스 검사는 사용자 요청에 따라 중단했다. 일반 회귀 테스트와 같은 조건의 성능 측정은 계속한다. 현재 후보에 성공한 퍼징 또는 Linux LeakSanitizer 증거가 있다고 주장하지 않는다.

### 2026-09-16 잔여 차이 후속 검증

[후속 PLAN](../plans/2026-09-16-nitro-parity-followup.md)에 따라 Android 버퍼의 순서 의존성, 실제 DFS의 보관 용량·스택 성장, 작은 호출 후보 및 큰 객체 직렬화를 조사했다. 작은 맵 인코더를 개선했고 악화된 postcard 후보는 폐기했다. 새 iOS/Android Release의 각 5회×90항목에서 공개 동기는 양쪽 20/30, Promise API는 iOS19/30·Android20/30이 동급 이상이다. 전 항목 목표는 미달이며 모든 판정·진단 한계는 [후속 결과](../research/2026-09-16-nitro-parity-followup.md)에 남겼다. 새 발행이나 플랫폼 인증 완료로 처리하지 않는다.
