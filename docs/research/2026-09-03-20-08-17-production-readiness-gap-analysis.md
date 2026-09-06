---
date: 2026-09-03 20:08:17 +0900
researcher: claude
git_commit: d41d2d277db4f25847d4c7fe686da72cfee35d51
branch: feat/tauri-channel-adapter
repository: loopy-lim/rustra
topic: "production readiness gap — 남은 작업·후속 과제·미구현 항목 전수 조사"
tags: [research, production-readiness, roadmap, release, compatibility-matrix, evidence, changelog, docs-gate]
status: complete
last_updated: 2026-09-03
last_updated_by: claude
---

# 리서치: production readiness gap — 남은 작업·후속 과제·미구현 항목 전수 조사

**날짜**: 2026-09-03 20:08:17 +0900
**연구자**: claude
**Git Commit**: d41d2d277db4f25847d4c7fe686da72cfee35d51 (feat/tauri-channel-adapter)
**Branch**: feat/tauri-channel-adapter
**Repository**: loopy-lim/rustra

## 연구 질문

현재 앞으로 production ready 상태를 만들기 위해 해야 하는 남은 것들이 무엇인가 — 남은 작업·후속 과제·미구현 항목을 전수 조사한다.

## 요약

**기능적으로는 실질 미구현이 0건이다.** `todo!()`/`unimplemented!()` 런타임 사용 0건, 활성 `#[ignore]` 0건, 1급 소스 TODO는 코드 이동 예약 1건뿐. 남은 갭은 전부 **(1) 미머지 자산의 통합, (2) 발행 사이클 완주, (3) 증거 격상, (4) 0.7 "신뢰" 잔여 항목, (5) 문서 정직성 잔여 결함** 다섯 부류로 수렴한다.

우선순위 순 요약:

| # | 갭 | 성격 | 규모 |
|---|---|---|---|
| 1 | 트랙 자산 미머지·미푸시 | 프로세스 | 현재 브랜치 +29커밋 미푸시, Tauri 채널 어댑터 완결 11커밋이 갈라진 워크트리 브랜치에 보존 |
| 2 | 0.7.0 발행 사이클 | 릴리스 | changeset 7개 대기(9패키지 전체), 그중 5개가 feat 브랜치에만 존재 → 머지 후 Version PR 재생성 필수. Rust 워크스페이스 0.5.0 미-bump |
| 3 | 레거시 제거 트랙 | 승인·미착지 | 설계 문서 "사용자 승인 완료"인데 코드 변경 0. legacy C 심볼이 무조건적으로 노출 중 |
| 4 | 증거 격상 | 1.0 과제의 전초 | README 증거 5행 중 3행이 Runtime verified 미만. iOS 실기기 증거 저장소 전체 부재. RN 런타임은 CI 게이트 밖(로컬 수동 영수증만) |
| 5 | 0.7 "신뢰" 잔여 | 기능 | withRetry, NDJSON 파싱 실패 라인 보존, 응답 셰이프 검증, thiserror 에러 매핑, Suspense 캐시/무효화, 필드 수준 계약 게이트(DX audit HIGH) |
| 6 | 문서 정직성 잔여 결함 | 정확성 | over-claim 1건(on_unimplemented), 루트 CHANGELOG 0.6 누락, `compatibility-contract.ko.md` 부재 |
| 7 | 소규모 청소 | 위생 | deprecated 3표면, dead_code 제거 후보 4건, docs-gate fail 전환 미결, wasm3 벤더 분리 검토 |

## 상세 분석

### 1. 트랙 자산 상태 — 미머지·미푸시가 최대 즉시 과제

- 현재 브랜치 `feat/tauri-channel-adapter`는 `origin/main`보다 **+29커밋 전부 미푸시**(역방향 0커밋 — 뒤처짐 없음).
- Tauri 채널 어댑터 트랙은 **완결돼 있다**: 워크트리 브랜치 `feat/tauri-channel-adapter-work`에 11커밋, `crates/rustra/src/tauri_support.rs`에 `rustra_channel_create`/`rustra_channel_drop` 구현 + `generate_handler!` 등록 완료, `packages/tauri/src/tauri-channels.ts` 존재, `docs/compatibility-matrix.md:17` Channels 행이 전부 ✅로 갱신됨(근사 유니캐스트 명시 포함). 워킹트리 깨끗.
- 두 브랜치는 **갈라진 상태**: 워크트리 +11 / 현재 브랜치 +1(merge-base `20051c87`). 계획 문서 `docs/plans/2026-09-03-tauri-channel-adapter.md`는 현재 브랜치에서 untracked — **커밋되지 않음**.
- PR #51(0.7.0 version PR)은 이 세션 네트워크 격리로 상태 확인 불가(gh DNS 실패). 로컬 `changeset-release/main` 브랜치 tip `bd72610b` 존재.

**남은 작업**: ① 계획 문서 커밋, ② 두 브랜치 통합(사용자 결정 규칙 유지), ③ main 푸시, ④ PR #51 상태 온라인 재확인.

### 2. 발행 사이클 — 9패키지 0.7.0 라인이 대기 중

`.changeset/` 대기 changeset 7개:

| Changeset | bump |
|---|---|
| `cli-ergonomy-exit2-help-json.md` | cli minor |
| `dx-single-arrow-codegen.md` | cli minor + 8패키지 patch |
| `generated-entry-subscribe-event.md` | cli/node/bun minor |
| `next-cycle-integration.md` | 5패키지 minor + 4패키지 patch (type-level breaking 2건 포함 대형 minor) |
| `roadmap-0.6-completeness.md` | cli/node/bun minor |
| `simplify-cleanup-internal-reuse.md` | cli/node/bun/devtools minor + 3패키지 patch |
| `version-alignment-testing-react.md` | testing/react minor |

- **핵심 갭**: 이중 5개가 `feat/tauri-channel-adapter` 브랜치에만 있고 `origin/main`에는 2개만 존재. **PR #51을 지금 머지하면 발행 분량이 2 changeset분이 되고 나머지는 머지 후 Version PR 재생성이 필요하다.**
- Rust 워크스페이스(`rustra-naming`/`rustra-macros`/`rustra`)는 `version.workspace = true`로 **0.5.0에 머물러** 있음. `dx-single-arrow-codegen.md`가 "The Rust `rustra` crate ships the same minor in its own Cargo workspace release"라고 명시하므로 crates.io 발행 전 수동 bump를 안 하면 버전 스킵 갭 발생.
- crates.io 발행(`release.yml` `cargo-publish` 잡)은 `workflow_dispatch` 전용 + 수동 버전 bump 절차 — 자동화 갭.
- 발행 파이프라인 자체의 readiness는 **양호**: `workflow_run: CI success on main` 게이트(schedule 오탐 가드 포함, 2026-09-01 오발행 시도 주석 기록), baseline fail 방치 잡 0건, `continue-on-error` 3건은 전부 비게이트 실험 트랙(bench/fuzz/miri). 현재 대기 단계는 `docs/release-procedure.md` 기준 Step 1~2 사이(Changeset 확정 ↔ canary 사전검증 사이, canary 흔적 없음).

### 3. 레거시 제거 트랙 — 승인 완료, 구현 미시작

`docs/plans/2026-09-03-legacy-removal-design.md`("사용자 승인 완료")이 선언한 제거 대상이 **현재 브랜치·워크트리 양쪽 모두 그대로 존재**:

- `examples/calculator/src/lib.rs:917` `rustra_calculator_invoke_bytes` + 참조 4곳(:1475, :1835, :1854, :1863) — legacy C 심볼 무조건적 노출 중.
- 흥미로운 발견: 설계 문서가 가정한 `RUSTRA_ENABLE_LEGACY_BENCHMARKS` ifdef는 양쪽 모두 grep 미히트 — **ifdef 게이트가 아직 도입 전**이라 제거 작업은 설계 문서의 "배경" 재검증부터 시작해야 한다.
- 동시 수修正 대상인 결함 A(JSI `invokeRkyvV2` 등록 공백)·결함 B(init 스캔폴드 `write_to_dir` 이중 작성자)도 미수정.

### 4. 증거 격상 — "지원"과 "증명"의 거리

README 증거 수준표(`README.md:620-632`):

| 플랫폼 | 증거 | 갭 |
|---|---|---|
| Node / Bun | Runtime verified | — |
| Tauri (macOS) | WebView runtime verified | 3본 중 1본 |
| Tauri (Linux) | Build + smoke verified | 실제 WebView 사용자 흐름 미검증 ("separate E2E") |
| RN iOS | Simulator runtime verified | **실기기 증거 저장소 전체 부재** |
| RN Android | Release runtime verified (TB710FU arm64) | 실기기 1종뿐 |
| (Tauri Windows) | **행 자체가 없음** | host 수준 실증 미실시 |

- **CI가 증거를 못 따라감**: `ci.yml`의 `rn-android`(:275-327)는 `assembleRelease` 빌드+.so 확인만, `rn-ios`(:331-371)는 시뮬레이터 부팅/런치 없이 빌드만. Node/Bun/Tauri 런타임 스모크도 ubuntu 단일 OS. 시뮬레이터/에뮬레이터 런타임 영수증은 전부 로컬 수동 캡처(`docs/benchmarks.md`, `examples/rn-wasm-spike/evidence/`)라 **재현성·회귀 감지가 안 됨**. `docs/benchmarks.md:110` "the C++ gate is not in CI" 명시.
- 매트릭스 잔여 ❌/⚠️: Channels Node/Bun ❌(로드맵 0.8 계열), RN JSON 이벤트 ❌, in-flight 취소 전 호스트 ⚠️ shallow, rkyv V2 배치 취소 ⚠️, RN JSON timeout ⚠️ 선점 불가. wasm은 dev-only 자체 규정(CI는 컴파일 check만, `compatibility-matrix.md:57-61` 증거도 시뮬레이터 한정).
- 로드맵 문서(`docs/plans/2026-09-01-roadmap-design.md:24,32,149`)가 이를 1.0 "증거 완결" 과제로 명시: iOS/Android 실기기 증거, Windows host 실증, 매트릭스 "별도" 셀 제로화.

### 5. 0.7 "신뢰" 잔여 — 선반영됐지만 끝나지 않은 트랙

0.7 착지 항목 중 **이미 착지**(선반영): cause 체인 보존(`packages/types/src/errors.ts:84-112`), Timeout/Cancelled 서브클래스(:26-42), RUSTRA_DEBUG 와이어 덤프(`packages/types/src/debug.ts`), 코드젠 unknown 폴백 경고(TS+Rust 양측), doc→JSDoc 전달, useCommand bigint inputKey 수정(`packages/react/src/input-key.ts:8-14`).

**미착지 (production ready 관점 남은 기능 갭)**:

| 항목 | 근거 | 비고 |
|---|---|---|
| withRetry 소비 유틸 | 전역 grep 0건 | `isRetryableCode`(`errors.ts:121-123`)만 존재 |
| NDJSON 파싱 실패 라인 보존 | `packages/node/src/node-loop.ts:270-275` `catch { continue; }` + :283 stderr 폐기 | DX audit MEDIUM 그대로. 단 push 이벤트 경로는 `node-events.ts:175-181`에서 부분 해소 |
| 응답 셰이프 검증 경고 | grep 0건 | RUSTRA_DEBUG 계열 미완성 축 |
| thiserror 에러 enum → TS 코드 매핑 | 문서/매크로 0건 | 리서치·로드맵에만 존재 |
| React Suspense 캐시/무효화 | `packages/react/src` 0건 | DX audit HIGH |
| **필드 수준 계약 게이트** | `packages/testing/src/contract-gate.ts:10-20` — 여전히 명령 이름 집합만 비교 | **DX audit HIGH, selling point(계약 소유) 핵심 자산과 직결** |
| `__RUstra_doc_` 죽은 상수 정리 | `crates/rustra-macros/src/macro_command.rs:108-109,182` | 목적은 달성됐으나 상수는 여전히 `#[allow(dead_code)]` 생성만 되고 소비처 없음 |

### 6. 문서 정직성 잔여 결함

- **over-claim 1건**: `docs/rust-api-guide.md:140`(+`.ko.md:138`)이 "`#[diagnostic::on_unimplemented]` produces a friendly error message"를 서술하지만 구현 0건 — `docs/research/2026-09-03-16-00-00-dx-macro-first-assessment.md:98`이 반증. 레거시 제거 설계 문서도 이 정정을 범위에 포함.
- **루트 CHANGELOG 0.6 누락**: "0.3→0.6 와이어 breaking 요약" 약속(`docs/plans/2026-09-01-roadmap-design.md:60`)이 부분 이행(0.5까지). 현실은 6패키지가 이미 0.6.0 발행 + `docs/migrations/0.5-to-0.6.md` 존재, 그러나 루트 CHANGELOG grep "0.6" 0건. Unreleased 섹션이 0.6.0 발행분을 흡수하지 못함.
- **en+ko 쌍**: 가이드 측 불일치는 `docs/compatibility-contract.md`의 `.ko.md` 부재 **1건뿐**(두 언어 인덱스에 등재돼 있어 ko 독자가 영문을 읽게 됨). docs/research/의 17건 단일 언어는 english-reorg 설계가 명시한 제외 구역(다만 성문화는 안 됨). README 로드맵은 en/ko 18항목 완전 동기화 확인.
- **docs-gate 커버리지**: 마커 채택이 2문서 쌍(types.ts/commands.ts)에 머무름. 산문 주장은 구조적으로 게이트 밖 — on_unimplemented over-claim이 그 대표 사례.
- 기타: 루트 `CHANGELOG.md`는 한국어 단일 언어(english-reorg 설계의 명시적 제외), `docs/.DS_Store` 커밋물 존재(폐기 대상).

### 7. 코드 위생 — 제거/정리 후보

- **deprecated 3표면** (0.x 호환 계약, 버전업 시 제거 후보): `crates/rustra/src/renderer_host.rs:126` `RendererHost` trait 전체, `packages/tauri/src/tauri-events.ts:54` 레거시 subscribeEvent 오버로드, `packages/react-native/src/react-native-events.ts:51` 동일.
- **dead_code 제거 후보**: `crates/rustra/src/rkyv_support.rs:14` `js_postcard_codec_supported`(주석 스스로 레거시 변형 명시), `crates/rustra/src/rkyv_fields.rs:13,32` `WireFieldKind` 전체, `crates/rustra/src/events_state.rs:15` `EventState::new()` 미사용 생성자, `crates/rustra/src/renderer_host.rs:189` `surface_destroyed`.
- **미결 의사결정 1건**: docs-gate fail 전환 여부(`scripts/docs-gate.mjs:64,234` — 현재 warn-only, "fail 전환은 후속 판단 사항" 명시).
- **"후속" 라벨 문구 정리**(구현 완료인데 라벨이 헷갈림): `crates/rustra/src/ffi_sync_entries.rs:76`(caller-buffer — 구현+테스트 존재), `packages/types/src/rkyv-engine-schema.ts:13` 등 에포크/취소 관련 다수.
- 유일한 1급 TODO: `packages/types/src/schema-postcard-node.ts:31` — resolveRef 접두사 판정의 json-wire 공용 export 이동 예약(문서화된 리팩터링 예약).
- **벤더 청소**: `examples/rn-wasm-spike/native/wasm3/` 벤더 TODO 21건 — 스파이크 예제 통째로 저장소 분리 검토 대상.
- 스킵 테스트는 전부 조건부+사유 명시(bun 러너 버그 우회 등)로 양성. 단 `transport-bench.test.ts:102,103,174`는 환경 미준비 시 조용히 건너뛰는 구조라 CI 커버리지 공백 여지.

## 코드 참조

- `docs/compatibility-matrix.md:12-18` — ❌/⚠️ 셀 밀집 구간(Events/Channels/취소/타임아웃 행)
- `README.md:620-632` — 증거 수준표(5행 중 3행 Runtime verified 미만)
- `.changeset/` — 7개 대기(5개는 feat 브랜치에만 존재)
- `.github/workflows/release.yml` — `workflow_run: CI success on main` 발행 게이트 + cargo 수동 발행 잡
- `Cargo.toml` (workspace) — Rust 3 crate 공통 0.5.0 (미-bump)
- `examples/calculator/src/lib.rs:917` — legacy C 심볼 잔존(제거 트랙 미시작 증거)
- `packages/node/src/node-loop.ts:270-275,283` — NDJSON 실패 라인/stderr 폐기
- `packages/testing/src/contract-gate.ts:10-20` — 이름 집합만 비교하는 계약 게이트
- `docs/rust-api-guide.md:140` — on_unimplemented over-claim
- `scripts/docs-gate.mjs:64,234` — fail 전환 미결
- `crates/rustra/src/renderer_host.rs:126` — deprecated RendererHost

## 아키텍처 인사이트

1. **"미구현"이 아니라 "미통합"이 병목**: 코드는 실질 완성 상태(todo!/unimplemented! 0건). 남은 작업의 대부분은 이미 완성된 자산의 머지·발행·증거화라는 프로세스 과제다. 이는 검증 4계율("완료 선언 전 적대적 재검증")이 실제로 작동해 왔다는 증거이기도 하다.
2. **증거의 등급화가 다음 전선**: 로드맵이 정의한 1년 축 2("증거의 등급화")가 현재 가장 두터운 갭. CI가 빌드·링크까지만 게이트하고 런타임 영수증이 로컬 수동 캡처에 머무는 구조는 "Runtime verified" 라벨의 재현성을 약화시킨다 — 회귀 감지 불가.
3. **계약 게이트 강화가 selling point의 직접 완성**: 필드 수준 diff 미검출(DX audit HIGH)은 "유일한 것(계약 소유)을 더 깊게"라는 0.7 전략의 핵심 미완성이자, 경쟁 도구와의 차별점 자산.
4. **문서-현실 일치는 게이트로만 유지된다**: docs-gate가 산문을 못 검사하는 한 over-claim 재발 가능. fail 전환 여부는 0.7 "신뢰" 테마(무언가 깨졌을 때 알 수 있게)와 직결된 미결 의사결정.

## 관련 리서치

- `docs/research/2026-08-29-22-46-49-dx-audit.md` — 미해결 축 출처(HIGH 2건 크로스체크됨)
- `docs/research/2026-09-03-16-00-00-dx-macro-first-assessment.md` — on_unimplemented over-claim 반증 출처
- `docs/research/2026-09-02-tauri-channel-spike.md` — Tauri 채널 어댑터 경로 확정
- `docs/plans/2026-09-01-roadmap-design.md` — 0.7/0.8/1.0 항목 정의 원전
- `docs/plans/2026-09-03-legacy-removal-design.md` — 승인·미착지 트랙 설계
- `docs/plans/2026-09-03-tauri-channel-adapter.md` — 완결·미머지 트랙 계획 (untracked)

## 미해결 질문

1. PR #51의 온라인 상태(머지 가능 여부, CI rollup) — 네트워크 복구 후 확인 필요.
2. Tauri 채널 어댑터 워크트리 11커밋과 현재 브랜치의 통합 순서·시점 — 사용자 결정 규칙([[channel-4host-track-complete]]).
3. RN iOS 실기기 증거 캡처의 실행 가능 일정 — 하드웨어 확보 여부에 좌우되는 1.0 전초 과제.
4. docs-gate fail 전환 시점 — warn-only 운영을 언제까지 유지할지.
