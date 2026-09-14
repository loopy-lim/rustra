# Rustra M0 안전성·릴리스 실행 계획

> 실행자는 `executing-plans` 절차로 항목별 구현과 검증을 수행한다. 체크박스는 실제 증거가 확보된 경우에만 갱신한다.

**Goal:** 로드맵 M0-1~M0-5를 실행 가능한 코드·발행 게이트·출처 감사로 연결한다.

**Architecture:** FFI 풀은 sender와 join handle을 소유하며 테스트에서는 drop으로 정리한다. Release는 후보 SHA를 고정하고 기존 안전성 workflow를 재사용해 새 검사 성공에 의존한다. 레지스트리 감사는 발행 없이 정확한 버전과 소스·artifact 증거를 보관한다.

**Tech Stack:** Rust std mpsc/Arc/Mutex, Node.js ESM/node:test, GitHub Actions, Miri, ASan/LSan, cargo-fuzz.

**Spec:** [로드맵 SPEC — M0 실행 계약](../specs/2026-09-14-rustra-roadmap.md#m0-실행-계약--2026-09-14-보완)

## 공통 제약

- 공개 FFI/TS 계약, pool 2개·queue 256개, 독립 패키지 버전을 유지한다.
- Miri leak/thread 검사와 Sanitizer 실패를 무시하지 않는다.
- 검사 성공은 실행한 SHA·환경·범위에만 귀속한다. M1~M4, 실기기, 장시간 사용은 완료로 표시하지 않는다.
- 기존 iOS 생성 파일은 보존한다. 발행·push·merge는 이번 구현에 포함하지 않는다.
- 커밋은 검증 후 파일별 계획과 한국어 메시지를 제시하고 사용자 확인을 받는다.

## Task 1 — 종료 가능한 풀과 실패 분류 (M0-1, M0-2)

**Files:** `crates/rustra/src/ffi_pool.rs`, `crates/rustra/src/complex_schema_ir*.rs`, `crates/rustra/src/complex_codec_{encode,decode}.rs`, `crates/rustra/src/complex_serde_{de_core,ser_core,support,tests}.rs`, `api-surface/snapshot.json`, `.github/workflows/miri.yml`, `.github/workflows/sanitizer.yml`, `scripts/run-safety-check.sh`, `scripts/run-safety-check.test.mjs`.

**Interfaces:** `AsyncPool::new()`, `submit(AsyncTask)`, `stats()`, `Drop`; 공개 `async_pool_stats()`는 초기화 없이 0 카운터를 반환한다. `run-safety-check.sh LABEL COMMAND...`는 `SAFETY_LOG_DIR`에 command.log/exit-code를 기록하고 원래 실패를 반환한다.

- [x] 기존 a08 테스트를 Linux Miri에서 실행해 남은 스레드 오류를 재현한다. ASan은 독립 실행해 같은 결함인지 분류한다.
- [x] ASan 원인은 재귀 IR의 강한 Arc 순환으로 확인했다(2,946 bytes/54 allocations). Weak 역참조와 재귀 Value fallback으로 소유권을 수정하고 self/mutual/shared/실패 경로 해제 회귀를 검증한다. 공개 ABI/wire는 유지한다.
- [x] 기존 a08 시나리오를 소유 풀로 전환하고 drop 후 invocation 정리·inflight 0·완료 수를 검증한다. 큐 포화/반복 생성·종료를 회귀 검증한다.
- [x] `AsyncPool`에 sender와 worker handle 소유권을 두고 Drop에서 sender를 먼저 버린 뒤 worker를 join한다. submit 전에 inflight를 예약하고 reject 시 되돌린다.
- [x] 로그 wrapper를 임시 디렉터리와 `sh -c 'echo diagnostic >&2; exit 7'`로 검증: stderr 보존, exit 7 유지, exit-code=7.
- [x] ASan 절대 log_path와 always artifact upload를 적용하고 Miri의 세 target을 각각 실행해 실패가 뒤 target을 숨기지 않게 한다.
- [x] `cargo test -p rustra`, Miri 3개 suite, Linux ASan/LSan을 실행해 원본 로그를 남긴다.

## Task 2 — 같은 후보의 발행 전 안전성 게이트 (M0-3)

**Files:** `scripts/check-release-gates.mjs`, `scripts/check-release-gates.test.mjs`, `.github/workflows/{release,miri,sanitizer,fuzz}.yml`, `package.json`.

**Interfaces:** `evaluateRuns(runs, {sha, workflow, repository})`는 같은 SHA·workflow·원본 repo의 최신 허용 run을 선택하고 completed/success 외에는 거부한다. CLI 기본은 CI/Miri/Sanitizer/Fuzz, `--ci-only`는 Release가 별도 새 안전성 job에 의존할 때만 사용한다.

- [x] fixture로 누락, 다른 SHA, CI schedule, 최신 failure/cancelled/queued, 재실행 attempt, 다른 repo, 올바른 성공을 검증하는 테스트를 먼저 쓴다.
- [x] GitHub API 페이지를 읽고 JSON 영수증과 비영 종료 코드를 반환하는 읽기 전용 CLI를 구현한다.
- [x] 안전성 workflow에 `workflow_call`/`candidate_sha`를 추가한다. checkout은 caller가 준 SHA로 고정하고 기존 schedule/dispatch를 유지한다.
- [x] Release candidate → Miri/Sanitizer/Fuzz → npm 또는 cargo publish 의존 관계를 만든다. 수동 cargo 경로에도 동일하게 적용한다. 발행 직전 CI를 다시 확인한다.
- [x] actionlint와 fixture를 통과시키고 실제 현재 SHA 조회가 현재 실패를 차단함을 확인한다. 원격 변경 workflow 실행은 push 전 미검증으로 기록한다.

## Task 3 — 레지스트리 조합 감사 (M0-4)

**Files:** `scripts/audit-release-registry.mjs`, `scripts/audit-release-registry.test.mjs`, `docs/release-matrix{,.ko}.md`, `package.json`.

**Interfaces:** `auditRegistry({root, fetchImpl})`는 manifest별 정확한 버전과 latest를 조회해 JSON 결과를 반환한다. `renderRegistryMarkdown(report)`는 같은 결과를 표로 만든다. CLI `--output PATH`와 선택적 반복 `--artifact PATH`를 지원한다.

- [x] npm 미발행(404), source unknown, 다른 gitHead, 다른 독립 버전, crate checksum 불일치·VCS 출처를 fixture로 검증한다.
- [x] npm metadata와 crates sparse index/archive를 조회한다. crate checksum 검증 후 `.cargo_vcs_info.json`을 읽으며 archive를 디스크에 풀지 않는다.
- [x] 후보 SHA, 조회 시각, exact/latest, 출처 비교, registry URL, dirty 상태와 artifact hash를 보관한다. unknown을 일치로 취급하지 않는다.
- [x] 현재 레지스트리를 실제 조회해 JSON/Markdown 영수증을 남긴다. RN native 및 codegen manifest의 로컬 hash를 별도 증거로 기록한다.

## Task 4 — 문서 정합성·검증 인계 (M0-5)

**Files:** `docs/{release-procedure,threat-model}{,.ko}.md`, 본 PLAN, `docs/verification/2026-09-14-m0-safety-release.md`, 로드맵 SPEC.

- [x] EN/KO에서 continue-on-error 드리프트를 고치고 주간 가시성/발행 차단/검사 대상의 차이를 기록한다.
- [x] 릴리스 절차에 후보 SHA, 실패 재실행, 모든 gate 성공 조건, 배포 감사·canary·수동 발행 경계를 반영한다.
- [x] `bun run test:release-tools`, `bun run test:docs`, `cargo fmt --all -- --check`, scoped clippy 및 Rust 회귀를 실행한다.
- [x] 변경 diff와 기존 dirty 파일을 재확인하고 원인·통과·미검증·파일별 커밋 계획을 인계한다.

## 실행 중 결정과 근거

- Ruling: 현재 checkout의 `codex/m0-safety-release-gates` 브랜치에서 작업한다. 기존 로드맵과 iOS untracked 파일을 그대로 유지하기 위해 별도 checkout 복사를 하지 않았다. 잘못된 선택이면 브랜치의 변경 파일 목록으로 분리할 수 있다.
- Ruling: 계획의 독립 Task 2/3과 확인된 codec 누수는 `subagent-driven-development`로 분담하고 최종 안전성·릴리스 리뷰를 별도로 수행한다. package.json과 최종 문서·검증 기록은 루트 담당으로 고정해 동시 쓰기를 피한다.
- Ruling: ASan도 풀 종료 문제라는 가설은 폐기한다. LeakSanitizer 스택과 수명 회귀 테스트가 재귀 IR의 소유권 순환을 확정했다. 풀만 수정하면 Miri도 그 다음에 같은 54개 누수를 보고한다.
- Ruling: 재귀 IR은 Weak 역참조로 순환을 끊고 기존 Value 코덱을 사용한다. 임시 Arc의 수명을 unsafe로 늘리거나 전체 arena를 새로 설계하지 않는다. 비용은 재귀 스키마의 중간 Value 할당이며 별도 release A/B로 범위를 측정한다.
- Ruling: Docker Linux ARM64에서 실제 Miri/ASan/Fuzz 검증을 진행한다. Actions의 x86_64 실행·새 workflow 원격 통합은 별도 미검증이다. 로컬 검증을 원격 발행 승인으로 바꾸지 않는다.

설계 참고: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Rust Sanitizer](https://doc.rust-lang.org/unstable-book/compiler-flags/sanitizer.html).

- Ruling: API 선언 수집기는 private IR/구조체도 보수적으로 추적한다. 공개 ABI 변경이 아닌 내부 Weak/풀 선언 차이만 확인한 뒤 `api-surface/snapshot.json`을 갱신했다. 잘못된 분류는 snapshot diff와 동작 테스트로 재검토할 수 있다.

## 완료 기록

2026-09-14 M0-1~~M0-5 구현·로컬 검증을 완료했다. [실행 결과](../verification/2026-09-14-m0-safety-release.md)와 [기계 판독 영수증](../verification/evidence/2026-09-14-m0-validation.json)에 범위·출처·미검증 항목을 남겼다. 후속 [G0 성능 기준선 PLAN](./2026-09-14-g0-performance-baseline.md)은 재귀 경로 A/B와 비재귀 control 회귀 제거를 별도로 수행한다. 새 Actions 실행과 발행은 미수행이며 G0 전체 또는 M1~~M4 완료를 뜻하지 않는다. 커밋은 사용자 확인 대기다.
