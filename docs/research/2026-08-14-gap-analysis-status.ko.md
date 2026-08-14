---
date: 2026-08-14T19:59:46+09:00
researcher: claude (loopy 세션)
git_commit: 4808fb8343048aac7a159055a4afee082c67adb3
branch: main
repository: rustra-bridge
topic: '프로젝트 현재 상태 파악 — 디자인 문서 페이즈 완료 상태, 미완료 항목, 다음 할 일'
tags: [research, codebase, plans, runner-template, cross-platform, windows]
status: complete
last_updated: 2026-08-14
last_updated_by: claude
---

# 리서치: 프로젝트 현재 상태 파악 — 페이즈 완료 상태·미완료 항목·다음 할 일

**날짜**: 2026-08-14T19:59:46+09:00
**Git Commit**: 4808fb83
**Branch**: main
**Repository**: rustra-bridge

## 연구 질문

현재 여기에서 무엇을 더 해야 할까? 부족한 것은 무엇인가? — 디자인 문서(`docs/plans/` 34개)의
페이즈 완료 상태와 실제 코드/템플릿 상태를 대조하여 잔존 갭과 다음 할 일을 도출한다.

## 요약

- **핵심 프레임워크는 완성**: rustra core/macros + 5 어댑터(Node/Bun/Tauri/RN/Lynx) + codegen,
  테스트 게이트 전부 green (`test:types` 24/24, `test:ts:node` 32/32, `test:packages` 24/24,
  `cargo test` 144).
- **런타임 증명 3/4 플랫폼**: macOS/iOS/Android 각 7/7 PASS. Windows만 코드·계획 완료 상태로 연기.
- **가장 큰 실질 갭 = runner/template 플랫폼 셸 부재.** 디자인 §2가 명시한
  `desktop/src-tauri/`, `mobile-android/{app,modules}/`, `mobile-ios/{app,modules}/` 가
  템플릿에 전혀 없다. `run.sh` 3종은 존재하지만 참조 파일이 없어 실행 즉시 실패하며,
  `app/package.json`의 codegen script가 echo 스텁이라 **템플릿 단독으로는 번들 빌드 자체가 불가능**.
  Phase 5 "완료" 표시는 "구조 + capability 추상 + 게이트 스크립트"까지만 사실이고,
  §7이 약속한 "스파이크에서 정제 추출한 핵심 파일"은 이루어지지 않았다.
- 그 외 갭: capability 구현체(NotifyCap·Mobile 브리지), Windows P1 FML PE 심볼, Android NDK 핀(P6),
  문서 상태 부채(구형 design "구현 대기" 방치), CI release/bench 워크플로 부재, crates.io 미발행(P7 전제).

## 상세 분석

### 1. 디자인 문서 페이즈 완료 상태 (docs/plans/ 34개 스캔)

**완료 (closed)** — impl 문서 체크박스/결과 문서로 확인:

| 디자인                              | 근거                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Documentation (05-13)               | docs/ 5트랙 실재, impl Task 1~9                                                                                       |
| Rust DX improvement (05-14)         | `bridge_type`/`build!`/`command` 매크로 실재 (설계는 `derive`였으나 attribute로 변경 적용)                            |
| Complex type testing (05-14)        | codegen Map/Tuple 지원 실재                                                                                           |
| rkyv-command-id (05-14)             | `invoke_rkyv_v2` (`crates/rustra/src/lib.rs:420`) 구현 완료 — **단 문서 헤더가 여전히 "설계 완료, 구현 대기"로 방치** |
| Runtime command registry (07-04)    | impl Done criteria 8/8 [x]                                                                                            |
| Dynamic rkyv path (07-04)           | impl Done criteria 6/6 [x]                                                                                            |
| Dynamic rkyv perf/types (07-05)     | 완료 기준 5/5 [x] (시뮬레이터 수동 검증 제외)                                                                         |
| Lynx adapter (08-10)                | `packages/lynx` + test:packages 24/24                                                                                 |
| rustra-lynx-runtime Phase A (08-10) | 10/10 ✅                                                                                                              |
| Tauri×Lynx desktop spike (08-11)    | 성공기준 4/4 PASS (경로 A SetParent)                                                                                  |
| Lynx mobile spike (08-11)           | iOS 7/7 + Android 7/7                                                                                                 |
| Cross-platform Phase 4/5 (08-12)    | §7 Phase 1~5 전부 ✅ 표시                                                                                             |
| Performance benchmark (08-13)       | 측정 완료 (전송/와이어포맷/Lynx QuickJS end-to-end)                                                                   |

**열려있음 (open)**:

1. **runner/template 플랫폼 셸** — 디자인은 완료 표시지만 실제 추출 미완료 (§2 참조)
2. **RN B1 디바이스 검증** — `2026-08-10-rn-b1-verification.md` 24항목 전부 [ ]
3. **P0-3 async offload (`invokeAsync` worker 큐)** — 설계만 확정, "후속 작업" 명시
4. **Windows 런타임** — P8 DEFERRED. P1 FML PE 심볼 해석이 유일 크럭스
5. **capability별 NativeModule 구현체** — mobile-spike-result "차기 과제"
6. **Trust test hardening (08-11)** — "구현 계획 진행 중" (F1/F2/F8 UB 결함 가시화 전략)
7. **RN 시뮬레이터 수동 체크리스트 (07-05)** — 18항목 전부 [ ]
8. **Masterplan (05-14)** — Status: Approved, 진척도 표시 전무 (ci.yml만 있고 release.yml/bench.yml 부재)

### 2. runner/template 실태 (디자인 §2·§7 대조)

| 디자인 항목                                                                           | 상태                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 최상위 구조 (app/backend/desktop/mobile-*/capabilities/create-runner.sh/README)       | ✅ 존재                                                                               |
| `backend/src/capabilities.rs` (FileCap/NotifyCap/Registry/DesktopRegistry + 테스트 3) | ✅ 구현·컴파일 검증                                                                   |
| `create-runner.sh` (복사 + 4종 식별자 치환)                                           | ✅ 구현 (단 path 의존성은 안내만)                                                     |
| `desktop/src-tauri/` (main.rs, lynx_host.mm/cpp)                                      | ❌ 없음 (run.sh 뿐)                                                                   |
| `mobile-android/{app/, modules/rustra-lynx/}`                                         | ❌ 없음                                                                               |
| `mobile-ios/{app/, modules/rustra-lynx/}`                                             | ❌ 없음                                                                               |
| 플랫폼 `run.sh` 게이트                                                                | ⚠️ grep 게이트 로직은 실제, 그러나 참조 파일 부재로 실행 즉시 실패                    |
| `app/package.json` codegen script                                                     | ❌ echo 스텁 → 템플릿 단독 `npm run build` 불가 (`App.tsx`가 `../generated/*` import) |
| Windows scaffold (verify-windows.ps1)                                                 | ❌ 없음 (스파이크에만 존재)                                                           |
| Mobile capability 브리지 (`rustra_register_file_callback`)                            | ❌ 문서만 (capabilities/README.md)                                                    |
| NotifyCap 구현체                                                                      | ❌ trait 정의만                                                                       |

핵심: 디자인 §7 "각 플랫폼 코드는 대응 스파이크에서 정제 추출 (전체 복사 아닌 **핵심 파일 + 포인터**)" 중
**"포인터"만 충족되고 "핵심 파일"이 없다.** run.sh 주석의 "▶ 스파이크에서 추출" TODO 4곳 참조.

### 3. 테스트·검증 게이트 현황

- 자동 게이트: `test:compat` (ts:node + ts:bun + adapters + runtime) — package.json 등록. green.
- **런타임 게이트는 package.json에 미등록** (수동 실행): `examples/lynx-tauri-spike/verify.sh` (7패턴),
  `examples/lynx-calculator/ios/verify-ios.sh` (7패턴), `android/verify-android.sh` (7패턴),
  `examples/lynx-tauri-spike/verify-windows.ps1` (7패턴, 단 `lynx_desktop_win.cpp` 미작성으로 전제 미충족).
- **P6 미반영**: `runner/template/mobile-android/run.sh`가 호출하는 `build-rust-android.sh` 자체가 없고,
  스파이크 원본에도 NDK 핀이 없음 (verify-android.sh에는 `NDK_VERSION=27.1.12297006` 핀 존재 — 이 로직 이식이 P6 조치).

### 4. 최근 세션 흐름 (git log)

마지막 3커밋은 벤치마크(`wire-bench.rs` + 문서) → Lynx QuickJS 실측 → generated/ 포맷 동기화.
즉 "증명·측정" 단계는 마무리되었고, 남은 것은 **증명된 것을 재사용 가능한 형태로 만드는 단계**다.

## 아키텍처 인사이트

- 이 repo의 관례: "in-session(자동 테스트) 완료"와 "디바이스/Windows 검증"을 분리하고,
  환경 제약으로 못 한 검증은 "정직한 연기"로 라벨링. 미완료의 대부분이 연기된 검증과 후속 설계에 집중.
- Phase 5 완료 선언의 미묘한 부풀림: 디자인 §7 스코프 문장("구조 + capability 추상 + instantiation + 게이트까지")은
  문자대로 충족되지만, §2 레이아웃 다이어그램과 README는 셸 코드가 존재하는 것처럼 서술하고 있어
  문서-실제 간 괴리가 있다. 이것이 "사용자가 run.sh만 실행하면 된다"는 §6 검증 게이트 전제를 무너뜨린다.
- Windows(P1)는 외부 의존(Windows 머신)이라 당장 진행 불가. 반면 플랫폼 셸 추출은 본 머신에서 전부 가능하다.

## 다음 할 일 우선순위 (제안)

1. **runner/template 플랫폼 셸 추출 완성** (본 머신 가능, 최고 가치) — 스파이크 3종에서
   `desktop/src-tauri/`, `mobile-ios/{app,modules}/`, `mobile-android/{app,modules}/` 핵심 파일 정제 추출.
   codegen 스텁을 실제 동작으로 교체(빈 command로 시작해도 `generate_typescript` 경로 확보).
   완료 기준: `create-runner.sh`로 생성한 프로젝트가 app 번들 빌드 + `desktop/run.sh` 게이트 통과.
2. **P6 조치** — verify-android.sh의 NDK 핀 로직을 build-rust-android.sh에 이식 (셸 추출과 동시 진행).
3. **문서 상태 부채 정리** — rkyv-command-id design 헤더 갱신("구현 완료"), masterplan 진척 표시,
   Phase 5 완료 표시에 셸 추출 잔존 명시(또는 1 완료 후 유지).
4. **capability 계층 B 확장** — Mobile 브리지 FFI(`rustra_register_file_callback`) + NotifyCap 구현체.
5. **Windows 런타임** (환경 의존) — Windows 머신 확보 후 `lynx_desktop_win.cpp` 작성 + P1 FML PE
   심볼(GetProcAddress → PE 오프셋 순) + `verify-windows.ps1` 7패턴.
6. **CI 보강** — release.yml/bench.yml (masterplan 잔존), 런타임 verify 스크립트 package.json 등록 논의.
7. **crates.io 발행 준비** (P7 해소 전제) — 템플릿 path 의존성의 근본 해결.

## 코드 참조

- `runner/template/backend/src/capabilities.rs:16-46` — FileCap/NotifyCap/CapabilityRegistry/OnceLock registry
- `runner/template/desktop/run.sh:27` — "▶ build-lynx-host.sh 를 스파이크에서 추출" TODO
- `runner/template/mobile-ios/run.sh:24-30`, `mobile-android/run.sh:26` — 동일 TODO
- `runner/template/app/package.json:10` — codegen echo 스텁
- `runner/template/capabilities/README.md:83-84` — mobile 브리지 "미구현" 자체 명시
- `examples/lynx-calculator/android/verify-android.sh` — NDK 핀 로직 (P6 이식 원본)
- `examples/lynx-tauri-spike/verify-windows.ps1` — Windows 7패턴 게이트 (lynx_desktop_win.cpp 전제)
- `docs/plans/2026-08-12-cross-platform-problems-review.md` — P1~P8 문제점 카탈로그 (현 기준 총정리)
- `docs/plans/2026-08-13-performance-benchmark.md` — 성능 측정 최종본

## 미해결 질문

- 템플릿 셸 추출의 정도: 스파이크 전체 복사 vs 최소 핵심 파일 — 디자인 §5(ackResult/FML 오프셋 제거) 기준 적용 시 재량 필요
- RN B1 디바이스 검증(24항목)의 우선순위 — Lynx 트랙이 RN 트랙을 사실상 대체했는지 여부에 따라 폐기/진행 판단
- trust-test-hardening의 F1/F2/F8 가시화 전략 진행 여부
