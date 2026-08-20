---
date: 2026-08-15T22:27:32+09:00
researcher: claude (loopy 세션)
git_commit: f187c2774ce2f9e286492ba627e27a4b5910bd00
branch: main
repository: rustra-bridge (remote: loopy-lim/rustra)
topic: '다음 작업 후보 도출 — 갭 클로저 이후 상태, 발행(publish) 준비도, 미완료 항목 전수 조사'
tags: [research, codebase, publish, npm, crates-io, windows, masterplan, next-steps]
status: complete
last_updated: 2026-08-15
last_updated_by: claude
---

# 리서치: 다음 작업 후보 — 갭 클로저 이후 상태·발행 준비도·미완료 항목

**날짜**: 2026-08-15T22:27:32+09:00
**Git Commit**: f187c277
**Branch**: main
**Repository**: rustra-bridge (remote: loopy-lim/rustra)

## 연구 질문

이제 다음 작업으로 할 만한 것들을 모두 추천해달라 — 어제(08-14) 갭 분석 리서치 이후
올라온 커밋(갭 클로저 G1–G5, 게이트 해소, 버전 범프)과 미커밋 변경(발행 준비)을 반영해
현재 상태를 전수 조사하고 작업 후보를 도출한다.

## 요약

- **G1–G5 갭 클로저는 구현·검증 완료** (커밋 3f6939e6/080b75c8): Task 1~7 전부 실제 결과물
  존재, 게이트 결과도 커밋 메시지에 기록(desktop 6/6, iOS 5/5, Android 5/5, 회귀
  cargo 146/0 · test:packages 24/24 · test:ts:node 32/32). 유일 잔존: **계획 문서의 완료
  기준 9개 체크박스가 미체크**이고 impl/결과 기록 문서가 없다.
- **발행(publish) 준비가 진행 중**: 미커밋 변경 8개 package.json(버전 0.1.1, repository URL
  수정, publishConfig.access public, directory 필드 수정).
  (2026-08-20 갱신: hostra 개명은 철회되어 `loopy-lim/rustra` 유지, npm 스코프도 `@rustra/*` 유지)
  발행 전 필수: cli/types README, dist 빌드(dist는 gitignore), crates.io 이름
  선점 확인, examples 우발 발행 방지.
- **기술적 하드 블로커는 Windows P1(FML PE 심볼) 하나뿐**이고 이는 Windows 머신 의존.
  본 머신에서 가능한 작업은 풍부: 발행 파이프라인, 문서 부채, invokeAsync 구현(설계만
  존재, 코드 0건), codegen 타입 확장(Set/Recursive/Discriminated union), 예제 문서화.
- **Trust test hardening은 완전 종료**(F1/F2/F8 전부 수정+활성 테스트) — 어제 리서치의
  "진행 중" 표기는 옛날 상태.

## 상세 분석

### 1. 갭 클로저(2026-08-14 계획) 완료 상태 검증

Task 1~7 결과물 전부 실재 확인:

| 항목                                                                         | 상태 | 근거                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop 셸 (src-tauri, lynx_desktop.mm, build-lynx-host.sh, TemplateApp.app) | ✅   | `runner/template/desktop/src-tauri/src/main.rs`, `lynx_desktop.mm`                                                                                                                                                          |
| iOS 셸 (app/, modules/rustra-lynx, project.yml, Podfile)                     | ✅   | `runner/template/mobile-ios/`                                                                                                                                                                                               |
| Android 셸 (app/, modules/, gradle wrapper 포함)                             | ✅   | `runner/template/mobile-android/`                                                                                                                                                                                           |
| codegen 실경로화                                                             | ✅   | `runner/template/backend/src/bin/generate.rs`, `app/package.json:10` → `codegen.sh` (dual-path: Rust bin + TS CLI 2종, `codegen.sh:35-46`)                                                                                  |
| capability 계층 B                                                            | ✅   | `backend/src/capabilities.rs` — MobileBridge 구조체(107행), MobileRegistry(118행), FFI `rustra_template_register_mobile_registry`(171행), 테스트 6개. iOS/Android 셸이 실제 호출(`RustraModule.m:94`, `rustra_jni.cpp:169`) |
| NDK 핀 + Windows 문서                                                        | ✅   | `build-rust-android.sh:25` (`27.1.12297006`), `desktop/WINDOWS.md` (111줄, 3포인트 포팅 가이드)                                                                                                                             |
| 문서 정리                                                                    | ✅   | rkyv-command-id 헤더 "구현 완료", runner-template §7 갱신, P6 해소 표시, capabilities README "구현됨", 루트 README runner/ 포함                                                                                             |
| create-runner.sh 절대경로 재작성                                             | ✅   | `create-runner.sh:68-87` — rustra path·@rustra file: 의존성을 원본 절대경로로 재작성                                                                                                                                        |

**유일 잔존**: `docs/plans/2026-08-14-gap-closure-production-ready-design.md:235-243` 완료
기준 9개 체크박스 전부 `- [ ]` + 헤더가 "Design + Impl Plan" + impl/결과 문서 부재
(검증 수치는 커밋 메시지에만 존재).

### 2. 발행(publish) 준비 상태

**미커밋 변경** (8개 package.json): 버전 0.1.0→0.1.1, repository URL
(과거 일시적 hostra 개명은 철회 — 현재 `loopy-lim/rustra`) 및 directory 필드 `"packages/"` → 정확한 하위경로로
수정, types에는 신규 추가), `@rustra/*` 7개에 `publishConfig.access: public`, 내부 의존
`@rustra/types ^0.1.1`. 루트는 `private: true` 유지.

\*_npm (packages/_ 7종)\*\*:

- 공통: files `["dist"]`, main/types/exports 구비, `type: module`, build=tsc.
- `dist`는 gitignore → **발행 전 `npm run build` 필수** (`release` 스크립트가
  `build && changeset publish`로 처리).
- **README 부재**: `packages/cli`(bin `rustra` + 5개 export 보유), `packages/types`.
- changesets 도입됨(`.changeset/config.json`, access public, baseBranch main) — 단
  changeset 파일 0개, 0.1.1은 수동 범프.
- (해소됨) 이름 불일치 — hostra 개명 철회로 `@rustra/*` 스코프와 저장소명 rustra 가 일치.

**crates.io (crates/rustra, crates/rustra-macros)**:

- workspace 상속으로 name/version/description/license/repository/readme 완비 —
  crates.io 필수 필드 충족. `publish = false` 없음.
- **주의**: workspace members에 examples 6개 포함 → `cargo publish --workspace`로 실수
  발행 위험. `-p rustra -p rustra-macros` 개별 발행 또는 examples에 publish=false 권장.
- rustra가 rustra-macros를 path 의존 → **macros 먼저 발행**해야 함.
- `crates/generated`는 크레이트가 아니라 TS 산출물 모음(발행 대상 아님).
- `rustra` 크레이트명 crates.io 선점 여부 미확인.

**CI/인프라**: `.github/workflows/`에 ci.yml 단 하나. release.yml·bench.yml 부재
(masterplan 잔여). CHANGELOG.md 부재. LICENSE MIT.

**저장소 정체**: `loopy-lim/rustra` (과거 일시적 hostra 개명은 철회 —
이름 변경 전환 중으로 보임).

### 3. 미완료 항목 카탈로그 (08-15 기준 최종)

| 항목                                      | 상태                        | 비고                                                                                                                                                                                      |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 런타임 (P1 FML PE 심볼 + P8 검증) | **open/deferred**           | Windows 머신 + `lynx_desktop_win.cpp` + `dumpbin /exports` 심볼 확인 → GetProcAddress(최선)→PE 오프셋 fallback. `verify-windows.ps1` 6패턴 준비됨                                         |
| RN B1 디바이스 검증                       | **open (24/24 미체크)**     | Lynx 트랙 대체 여부 판단 보류. 단 §5 latency 목표는 `docs/benchmarks.md:180-194`에서 이미 달성(0.95µs vs Nitro 1.10µs) — 폐쇄 근거 존재                                                   |
| P0-3 invokeAsync worker 큐                | **open — 설계만, 코드 0건** | `crates/rustra`·`packages/node`에 invokeAsync 부재. 현재 rkyv V2는 동기 JSI라 긴 Rust 연산 시 jank 가능                                                                                   |
| Trust test hardening                      | **closed**                  | F1(catch_unwind `ffi.rs:251`)/F2(debug allocator `ffi.rs:97`)/F8(null 체크) 전부 활성 테스트. Phase 0~3 완료                                                                              |
| Masterplan (05-14)                        | **open 다수**               | release.yml/bench.yml, crates.io 발행, Set/Recursive/Discriminated unions, Streaming/Auth 예제, `rustra init`, 메모리 프로파일링, retryable 메타데이터(필드는 있으나 전부 false 하드코딩) |
| P1~P8 문제 카탈로그                       | 7/8 closed                  | P1(HIGH)+P8(종속)만 open                                                                                                                                                                  |
| 벤치마크                                  | closed                      | 측정 풍부(어댑터/transport/온디바이스/페이로드). 추가 계획은 masterplan 4-2에만                                                                                                           |
| 예제 문서화                               | 부분 open                   | `lynx-calculator`·`lynx-tauri-spike` README 부재, `calculator-napi`는 루트 README에 미언급                                                                                                |

## 다음 작업 후보 (우선순위 제안)

### 트랙 A — 발행(publish) 파이프라인 [미커밋 변경의 자연스러운 연장선, 최고 우선]

1. 미커밋 package.json 8개 커밋.
2. (해소됨) 스코프는 `@rustra/*` 로 확정 — hostra 개명 철회.
3. `packages/cli/README.md`, `packages/types/README.md` 작성.
4. crates.io `rustra` 이름 선점 확인 + `cargo publish --dry-run`.
5. examples 6개 workspace 멤버에 `publish = false` (우발 발행 방지).
6. CHANGELOG.md 작성 (0.1.1 첫 공개).
7. `release.yml` (changesets npm + cargo publish) — masterplan 잔여 해소.
8. rustra(→macros 먼저) crates.io 발행 → P7 근본 해소(템플릿 path 의존성 → version 핀).

### 트랙 B — 문서 부채 (quick wins)

1. 갭 클로저 계획 체크박스 9개 체크 + 헤더 갱신 + 결과 문서(커밋 메시지의 게이트 수치 이식).
2. lynx-calculator·lynx-tauri-spike README (iOS/Android/Windows 검증 절차 포함).
3. 루트 README에 calculator-napi 추가 (또는 폐기 결정).
4. Masterplan 진척 표 갱신.

### 트랙 C — 기능 확장 (본 머신 가능)

1. P0-3 invokeAsync worker 큐 구현 (설계 존재: `2026-08-09-rn-native-perf-b1-phase0-design.md:75`).
2. codegen 타입: Set / Recursive / Discriminated unions.
3. Streaming·Auth 예제, `rustra init` CLI.
4. retryable 에러 메타데이터 실구현.

### 트랙 D — 환경 의존 (외부 전제)

1. Windows P1: Windows 머신 확보 → `lynx_desktop_win.cpp` + FML 심볼(GetProcAddress 우선).
2. RN B1 24항목 — 또는 Lynx 트랙 대체 선언 후 폐기 (§5는 이미 벤치마크로 달성).

### 트랙 E — CI/품질

1. `bench.yml` 벤치마크 회귀 감지.
2. 런타임 verify 스크립트(desktop/mobile-ios/mobile-android run.sh) package.json 등록 논의.
3. 메모리 프로파일링 벤치마크.

## 코드 참조

- `docs/plans/2026-08-14-gap-closure-production-ready-design.md:235-243` — 미체크 완료 기준
- `runner/template/backend/src/capabilities.rs:107,118,171` — MobileBridge/MobileRegistry/FFI 등록
- `runner/template/create-runner.sh:68-87` — 절대경로 재작성 (이미 구현됨)
- `runner/template/mobile-android/modules/rustra-lynx/build-rust-android.sh:25` — NDK 핀
- `runner/template/desktop/WINDOWS.md` — Windows 포팅 3포인트 가이드
- `packages/cli/package.json` — bin + exports 보유하나 README 부재
- `.changeset/config.json` — changesets 설정 (사용 안 됨)
- `docs/plans/2026-08-12-cross-platform-problems-review.md:27-36` — P1 FML PE 크럭스
- `docs/plans/2026-08-09-rn-native-perf-b1-phase0-design.md:75` — invokeAsync 설계
- `docs/benchmarks.md:180-194` — 온디바이스 실측 (RN B1 §5 근거)

## 히스토리 컨텍스트

- `docs/research/2026-08-14-gap-analysis-status.ko.md` — 전날 갭 분석 (G1~G5). 본 리서치는
  그 후속으로, 갭 클로저 완료를 검증하고 발행 준비 상태를 추가 조사함.

## 미해결 질문

- npm 스코프: `@rustra/*` 유지 확정 (hostra 전환은 철회됨).
- crates.io `rustra` 이름 가용성 (조회 필요).
- RN 트랙 폐기 여부 — B1 체크리스트 24항목의 운명.
- 런타임 verify 스크립트의 CI 통합 방식 (시뮬레이터/에뮬레이터 CI 실행 가능성).
