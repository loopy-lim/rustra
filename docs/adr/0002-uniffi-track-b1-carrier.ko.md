[English](./0002-uniffi-track-b1-carrier.md)

# ADR 0002 — Track B1: UniFFI 를 Kotlin/Swift 언어 캐리어로 채택

- 상태: Accepted
- 날짜: 2026-09-11
- 관련 문서: [ADR 0001](0001-record-track-a-contract-mechanization.ko.md),
  [`docs/research/2026-09-11-uniffi-maturity-catchup.ko.md`](../research/2026-09-11-uniffi-maturity-catchup.md)(역사 문서),
  [`docs/plans/2026-09-11-uniffi-track-b1-phase1.md`](../plans/2026-09-11-uniffi-track-b1-phase1.md),
  [UniFFI 바인딩 가이드](../extending/uniffi-bindings.ko.md)

## 상태 (Status)

Accepted — 2026-09-11. Phase 1(타입 안전 per-command API)이 B1-1~B1-5 로 착지했다.

## 배경 (Context)

ADR 0001 이 rustra 자신의 계약을 기계화한(Track A) 뒤 남은 질문은 언어
커버리지였다: TS 레이어 없이 Rust 를 소비하려는 순수 Kotlin(Android)/Swift(iOS)
호스트를 무엇이 받쳐주는가. 선택지는 세 개였다.

1. **B2 — 자체 native bindgen**: postcard/rkyv V2 blob ABI 위에 Kotlin/Swift
   코드 생성기를 직접 작성한다.
2. **B1 — Mozilla UniFFI 캐리어**: uniffi 가 Kotlin/Swift 바인딩과 값 전송을
   생성한다.
3. 앱별 수작업 FFI — 제품이 아니라 반복 노동이다.

2026-09-11 성숙도 조사와 부착 스파이크(cdylib 공존 nm 체크, 3언어 생성, Swift
E2E, iOS 크로스빌드 실측)가 근거를 제공했고,
[`docs/plans/2026-09-11-uniffi-track-b1-phase1.md`](../plans/2026-09-11-uniffi-track-b1-phase1.md)가
방향을 확정했다. 이 ADR 은 착지 결과를 기준으로 확정 결정을 기록한다.

## 결정 (Decision)

### 1. B1 캐리어 — B2 자체 bindgen 기각

Kotlin/Swift 바인딩은 uniffi 가 생성한다(uniffi 0.32, library 모드
bindgen). 이 표면의 정합성은 rustra 가 아니라 **uniffi 자체의 심볼별
체크섬 + 계약 버전**이 담당한다 — ADR 0001 의 Track A 철학을 캐리어가 적용하는
형태다. 따라서 rustra 의 `contract_hash`/`contract.mismatch` 게이트는
blob 전송 표면(JSI/Tauri/Bun/Node)에만 스코프가 머문다. B2 를 기각한 이유:
코덱·리프트/로워·체크섬을 자체 재발명하는 비용 대비 uniffi 성숙도가 압도적이고,
커맨드 추가가 스키마 walk 에서 자동 반영된다.

### 2. 코어는 uniffi-free — `invoke_typed` 는 평범한 Rust

`crates/rustra` 는 uniffi 의존/feature 를 얻지 **않는다**. 대신:

- `Package::invoke_typed<I, O>(name, &input)`
  (`crates/rustra/src/invoke_typed.rs`) — 이름→commandId 조회, postcard 요청,
  `invoke_rkyv_v2` 단일 dispatch 경로. JSON 실행 경로를 이원화하지 않아
  Rust↔TS 바이너리 호환이 코드 중복 없이 유지된다.
- `decode_rkyv_v2_response`/`decode_rkyv_v2_error_parts`
  (`crates/rustra/src/rkyv_error.rs`) — 응답 프레임 분리 공용 헬퍼.

uniffi derive 는 전부 **앱 크레이트 쪽 생성 미러 계층**
(`uniffi_generated.rs`, `#[cfg(feature = "uniffi")] include!`)에 놓인다.
기본 빌드는 uniffi 없이 과거와 동일하다. (계획서는 코어에 `uniffi` feature 와
객체 래퍼를 제안했으나 착지 과정에서 개정됐다 — 계획서 부칙 참고.)

### 3. 스키마 기반 미러 생성 + 문서화된 갈림

미러 계층은 손으로 쓰지 않는다 — 프로브가 스키마에서
`uniffi_generated.rs` 를 렌더링하고(렌더러 fail-closed, 조용한 skip 없음,
단위 테스트 11개), 커밋해 신선도 게이트(`codegen --check` 의 바이트 비교
— 빌드는 check 모드에서 의도적으로 생략)가 지킨다. 미러로 표현 불가능한
타입의 기계적 갈림은 문서화된다: set→`Vec` 미러 + 변환 시 실제 `BTreeSet`
수집, 고정 튜플→합성 record(`SpanInputPair`), map→추론 기반 collect,
`getSchema()`→live_schema(세대 카운터 포함), 채널/리소스 핸들 newtype→u32 +
명시적 경로 표.

### 4. 열린 에러 코드 공간 — 단일 변형 record, enum 매핑 기각

생성 에러 타입은 단일 변형
`RustraCommandFailure.Failure { code, detail, retryable }`(TS
`RustraCommandError` 와 동일 형태)다. rustra 의 에러 코드는 커스텀 문자열까지
열려 있으므로 코드 공간을 폐쇄해야 하는 uniffi enum 매핑은 설계상 불가능하다 —
기각이 아니라 **원천력 불가**다.

### 5. 정적 로딩 전용 — 핫스왑 제외

uniffi 호스트는 로드 시점에 심볼을 바인딩하므로 이 표면은 정적/릴리스 빌드
전용이다. dylib 핫스왑(`hot-core`)과 조합 불가 — dev 루프는 기존 TS/JSI
경로를 유지한다. Phase 1 제외: events/channels(Phase 2 — callback interface +
foreign trait), 비동기 명령(Rust 커맨드 API 가 현재 sync), XCFramework/AAR
발행 파이프라인(후속).

### 6. exact pin

워크스페이스 의존 `uniffi = "=0.32.1"`. 생성 바인딩과 런타임 헬퍼가
minor 마다 깨지는 churn 실측(성숙도 조사)에 따른 규율이다.

### 7. api-surface 스냅샷 스코프 밖

매크로 생성 `uniffi_*` 스캐폴딩 심볼은 api-surface 스냅샷의 수집 대상
(`crates/rustra/src`, `crates/rustra-macros/src`, `packages/*/src/index.ts`)에
나타나지 않는다 — 스캐폴딩은 example 앱 크레이트의 cdylib 에 귀결되기
때문이다. 이 표면의 정합성은 결정 1(uniffi 체크섬)이 담당하므로 스코프 확장은
하지 않는다.

## 결과 (Consequences)

- **긍정**: 타입 안전 Kotlin/Swift 표면을 bindgen 자체 개발 없이 확보했다.
  dispatch 진실의 원천은 `invoke_rkyv_v2` 하나로 남고, 코어는 uniffi-free 로
  기본 빌드가 가볍다. 커맨드/타입 추가는 스키마에서 자동 반영된다.
- **부정/비용**: 호출당 미러 변환 2회 + 내부 postcard 왕복 오버헤드가 있다
  (단일 와이어 단순성을 산 대가 — 벤치는 후속). 문서화된 미러 갈림 목록을
  스키마 진화와 함께 유지해야 한다. uniffi exact pin 은 버전 업그레이드를
  전원 일괄(코어+미러+커밋 바인딩 동시 재생성)로 강제한다. 모바일 런타임
  E2E(Android 에뮬레이터/iOS 시뮬레이터 스모크, uniffi-android/uniffi-ios CI
  잡)가 별도로 착지한다.
- **중립**: 기존 tier(JSI/Tauri/Bun/Node)와 병존 — 기존 사용자에게 동작
  변화 없다. events/channels·비동기·발행 파이프라인은 후속 ADR/계획의
  대상이다.
