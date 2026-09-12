# UniFFI Track B1 Phase 1 — 타입 안전 per-command Kotlin/Swift API (2026-09-11)

상태: **complete**(2026-09-11 착지 — B1-1~B1-5). 착지 확정 기록은
[ADR 0002](../adr/0002-uniffi-track-b1-carrier.ko.md), 사용자 가이드는
[UniFFI 바인딩 가이드](../extending/uniffi-bindings.ko.md). 선행:
`docs/research/2026-09-11-uniffi-maturity-catchup.md`(성숙도 갭),
2026-09-11 부착 스파이크(공존·3언어 생성·Swift E2E·iOS 크로스빌드 실측), ADR-0001(Track A).
확정 결정: **B1 UniFFI 캐리어 채택**, Phase 1 = **타입 안전 per-command API까지**, 우선 언어 **Kotlin(Android) + Swift(iOS)**.

## 설계 결정

1. **전송 모델** — uniffi는 rustra blob ABI와 별개의 "native value transfer" 전송이다.
   값은 uniffi 자체 RustBuffer lift/lower로 건너므로 호스트 측 postcard 코덱(Kotlin/Swift
   디코더)이 불필요 — uniffi가 record→Kotlin data class/Swift struct 변환을 생성한다.
   기존 tier(JSI/Tauri/Bun)와 병존하며, 이 표면의 정합성은 uniffi 체크섬이 담당한다
   (Track A api-surface v2와 동일 철학). `contract_hash` 게이트는 blob 전송 표면에만 적용됨을 문서화.
2. **Rust 익스포트 계층** — `crates/rustra`에 `uniffi` feature: 객체 `RustraPackage`(Arc) +
   제네릭 `invoke_typed<I, O>` 헬퍼. 내부는 기존 레지스트리 dispatch 재사용 — 값→postcard
   내부 왕복(단순, 배포 경로 단일) vs 핸들러 직결(전환 0, 내부 API 의존)은 구현 시 벤치로 결정.
3. **타입 변환 — 미러 타입 생성**(결정점): `#[bridge_type]` 타입에 uniffi derive를 직접
   붙이지 않는다(feature 게이트·매크로 크레이트 결합 문제). 대신 생성 `uniffi_exports.rs`가
   uniffi derive를 단 미러 타입 + From 변환을 동반한다 — 호출당 변환 2회 비용, 벤치 메모 필수.
4. **코드젠** — Rust probe(`generate.rs`)가 설정 시 `uniffi_exports.rs` 생성(커맨드별
   `#[uniffi::export]` 타입 함수). TS CLI는 uniffi-bindgen 구동(Kotlin/Swift 바인딩 산출) +
   Gradle/Xcode 접합 스캐폴드(`renderReactNativeModule` 선례). 기존 등록 5지점 패턴 준수
   (config.ts 키·cli-options.ts·generate barrel·cli-generate-files·stageFor).
5. **에러 매핑** — `RustraError` 열린 코드 공간 → uniffi Record `{code, message, retryable}`
   (TS `RustraCommandError`와 동일 형태). uniffi enum 매핑은 기각 — 코드 공간을 폐쇄할 수 없음.
6. **명시적 제외(Phase 1)** — events/channels(Phase 2: callback interface + foreign trait),
   핫스왑(uniffi 호스트는 로드 시점 심볼 고정 — **정적/릴리스 모드만 지원**, dev 루프는 기존
   TS/JSI 경로 유지, 문서 명시), XCFramework/AAR 발행 파이프라인(1단계는 로컬 빌드 + 생성
   바인딩 소스 검증까지, 발행은 후속).

## 작업 분해

- **B1-1**: `uniffi` feature + `RustraPackage` 객체 + `invoke_typed` + 에러 매핑 + api-surface
  스냅샷 범위 결정(매크로 생성 `uniffi_*` 심볼은 수집기 밖임이 확인됨 — 제외 명시 or 확장).
- **B1-2**: Rust probe의 `uniffi_exports.rs` 생성 + calculator 예제 적용.
- **B1-3**: CLI — uniffi-bindgen 구동 + Kotlin/Swift 바인딩 산출 + 모바일 접합 스캐폴드.
- **B1-4**: Android 에뮬 E2E(타입 함수 호출 스모크 — 핫코어 5→105 선례) + iOS 시뮬 E2E.
- **B1-5**: 문서(compatibility-matrix 열 추가, extending 가이드) + ADR-0002(전송 모델·계약 경계).

## 검증 게이트

- 스파이크 선례 재현: cdylib 공존 nm 체크, 생성 바인딩 컴파일(swiftc/코틀린 컴파일 가능 범위).
- Android: 에뮬레이터에서 타입 함수 호출 스모크 마커, iOS: 시뮬레이터 동일(Track A의
  `__RUSTRA_SMOKE_OK__` 패턴 재사용).
- 기존 게이트 전체 무손상(api-surface v2, codegen-fresh, docs-gate 미러, C++ 코덱, cross-wire).
- 변환 오버헤드 벤치: 미러 타입 변환 + 내부 postcard 왕복 유무 A/B(교차 반복 — 순차 측정 금지).

## 미확정(착지 중 판정)

- `invoke_typed` 내부 경로(레지스트리 postcard 왕복 vs 핸들러 직결) — 벤치 결과로.
- Kotlin 검증 환경: JNA 런타임 의존 버전 고정, Gradle 스캐폴드 범위(바인딩 소스만 vs 모듈 생성까지).
- uniffi 버전 고정 정책(Track A에서 확인한 minor별 breaking churn — 워크스페이스 exact pin).

## 부칙 — 착지 시 개정 (2026-09-11)

설계 결정 2(Rust 익스포트 계층)는 착지 과정에서 개정됐다: `crates/rustra` 는
**uniffi 의존과 `uniffi` feature 를 얻지 않았다**. 대신 평범한 Rust 두 조각이
코어에 착지했다:

- `Package::invoke_typed<I, O>`(`crates/rustra/src/invoke_typed.rs`) — 이름→commandId
  조회, postcard 요청, `invoke_rkyv_v2` **단일 dispatch 경로**. 객체 래퍼
  `RustraPackage`(Arc)는 도입하지 않았고, "값→postcard 내부 왕복" 선택
  방향은 그대로다(위 미확정 1번은 후속 벤치 과제로 남는다).
- `decode_rkyv_v2_response` / `decode_rkyv_v2_error_parts`
  (`crates/rustra/src/rkyv_error.rs`) — 응답 프레임 분리 공용 헬퍼.

uniffi derive 는 전부 **앱 크레이트 쪽 생성 미러 계층**(`uniffi_generated.rs`,
`#[cfg(feature = "uniffi")] include!`)에 놓인다 — 설계 결정 3의 "미러 타입
생성"이 채택된 형태다. 생성 파일명은 계획의 `uniffi_exports.rs` 가 아니라
`uniffi_generated.rs` 로 착지했다. B1-3 에서 Kotlin/Swift 바인딩 산출과
산출물 fail-closed 검증까지 착지했고(Gradle/Xcode 접합 스캐폴드는 후속),
B1-4 모바일 E2E 는 별도 트랙으로 착지가 진행 중이다. uniffi 버전 고정 정책은
워크스페이스 exact pin(`uniffi = "=0.32.1"`)으로 확정됐다. 위 역사 기술은
계획 시점의 제안을 보존한다.
