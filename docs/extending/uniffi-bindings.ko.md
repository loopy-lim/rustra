[English](./uniffi-bindings.md)

# UniFFI 바인딩 가이드 (Kotlin/Swift)

## 1. UniFFI 전송이란?

UniFFI 는 rustra 의 네 번째 호스트 표면으로, 기존 tier(JSI/Tauri/Bun/Node)와
**병존**한다. 기존 tier 가 TS 엔진이 postcard/Frame blob 을 왕복시키는 모델이라면,
UniFFI 는 **native value transfer** 다: Mozilla UniFFI 가 생성한 Kotlin/Swift
바인딩이 uniffi 자체의 RustBuffer lift/lower 로 값을 건네고, 커맨드 하나당 타입
함수(`addNumbers(input: AddNumbersInput) -> AddNumbersOutput`)가 생성된다.
Kotlin/Swift 쪽 postcard 코덱은 필요 없다 — record→data class/struct 변환을
uniffi 가 생성하기 때문이다.

선택 기준:

| 상황                                                               | 권장                                              |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| React Native 앱 — TS 에서 `engine.invoke`                          | 기존 JSI/Frame 경로(이 가이드 불필요)             |
| 순수 Android(Kotlin)/iOS(Swift) 앱 — TS 레이어 없이 Rust 직접 호출 | UniFFI(이 가이드)                                 |
| Tauri 앱 — 웹뷰가 Rust 호출                                        | Tauri adapter([Tauri 셋업](tauri-setup.ko.md))    |
| Node/Bun 백엔드                                                    | 생성 엔트리([시작하기](../getting-started.ko.md)) |

UniFFI 표면의 계약 정합성은 rustra 가 아니라 **uniffi 자체의 체크섬 + 계약
버전**이 담당한다(ADR 0001 의 Track A 철학을 캐리어가 그대로 적용한 형태).
rustra 의 `contract_hash`/`contract.mismatch` 게이트는 blob 전송
(JSI/Tauri/Bun/Node) 범위에 머문다 — 결정 기록은
[ADR 0002](../adr/0002-uniffi-track-b1-carrier.ko.md).

## 2. 아키텍처 — 코어는 uniffi-free

`crates/rustra` 는 uniffi 의존을 갖지 않는다. 코어에 착지한 것은 평범한 Rust
두 조각이다:

- `Package::invoke_typed<I: Serialize, O: DeserializeOwned>(name, &input)`
  (`crates/rustra/src/invoke_typed.rs`) — 이름으로 커맨드를 조회해
  commandId + postcard 로 Frame 요청 프레임을 조립하고
  `invoke_frame` 의 **단일 dispatch 경로**로 실행한다. 별도의 JSON 실행
  경로를 이원화하지 않으므로, TS 코덱이 보는 와이어와 Rust 내부 호출 와이어가
  바이트 수준에서 같은 원천이다.
- `decode_frame_response(frame)` / `decode_frame_error_parts(frame)`
  (`crates/rustra/src/frame_error.rs`) — 응답 프레임을 성공 본문/에러
  `{code, message}` 로 분리하는 공용 헬퍼. 알려진 한계: `RustraError` 의
  `code` 는 `&'static str` 이라 와이어의 동적 코드를 무할당 재구성할 수
  없으므로, 통합 디코더(`decode_frame_response`)는 에러를
  `internal: "<code>: <message>"` 형태로 합쳐 전달한다 — 정확한 부분이 필요한
  파서는 구조화 변형(`decode_frame_error_parts`)을 쓴다.

uniffi derive 는 전부 **앱 크레이트 쪽 생성 미러 계층**에 놓인다. 코드젠이
렌더링한 `uniffi_generated.rs` 는 미러 타입(record/enum) + 커맨드별
`#[uniffi::export]` 타입 함수 + 크레이트 루트의 `uniffi::setup_scaffolding!()`
로 이루어지며, lib.rs 는 feature 게이트로 붙인다:

```rust
#[cfg(feature = "uniffi")]
include!("uniffi_generated.rs");
```

기본 빌드에는 uniffi 가 전혀 개입하지 않는다 — `--features uniffi` 빌드에서만
cdylib 에 스캐폴딩이 얹힌다.

## 3. 설정 — `rustra.json` 의 `uniffi` 섹션

```json
{
  "uniffi": {
    "output": "uniffi"
  }
}
```

| 키             | 필수 | 기본      | 설명                                                                        |
| -------------- | ---- | --------- | --------------------------------------------------------------------------- |
| `output`       | ✅   | —         | uniffi-bindgen 이 Kotlin/Swift 바인딩을 쓰는 디렉터리(config 기준 상대경로) |
| `srcOut`       | —    | `"src"`   | 프로브가 `uniffi_generated.rs` 를 쓰는(그리고 커밋되는) 디렉터리            |
| `dylibProfile` | —    | `"debug"` | 바인딩 생성에 쓸 cdylib 빌드 프로필(`"debug"` 또는 `"release"`)             |

uniffi 섹션의 **존재 자체가 기능 스위치**다 — 없으면 코드젠 흐름은 섹션이
없던 이전과 바이트 동일하게 동작한다.

앱 크레이트 쪽 요구사항(calculator 예제가 기준 구현 —
`examples/calculator/`):

1. `[lib] crate-type = ["rlib", "cdylib"]` — library 모드 bindgen 이 cdylib 을
   읽는다.
2. `uniffi = ["dep:uniffi"]` 피처(워크스페이스 의존은 exact pin — §8).
3. `src/bin/uniffi-bindgen.rs`:
   `fn main() { uniffi::uniffi_bindgen_main() }`.
4. 프로브 바이너리가 `RUSTRA_UNIFFI_OUT` 환경변수를 존중해 미러 소스를
   렌더링한다(`examples/calculator/src/bin/generate.rs` 참고).
5. lib.rs 의 `#[cfg(feature = "uniffi")] include!(...)` 접합(§2).

## 4. 코드젠 흐름

`rustra codegen --config rustra.json`(쓰기 모드)의 uniffi 단계:

1. **스키마 프로브** — 기존 프로브를 `RUSTRA_UNIFFI_OUT=<srcOut>` 환경변수와
   함께 스폰한다. 프로브는 미러 소스를 `uniffi_generated.rs` 로 렌더링해
   srcOut 에 쓴다(커밋 대상).
2. **cdylib 빌드** — `cargo build --package <pkg> --lib --features uniffi
--message-format=json`(release 프로필이면 `--release`). 선택한 lib 타깃의
   compiler artifact에서 실제 경로를 받아 사용자 지정 이름·타깃 디렉터리·트리플을 따른다.
3. **bindgen** — 라이브러리의 Cargo 빌드 타깃과 관계없이 Rust 호스트 `--target`으로
   실행하고, 빈 임시 디렉터리에 바인딩을 생성한다.
4. **산출물 검증과 교체** — 새 디렉터리에 `.kt`, `.swift`, `.h`, `*.modulemap`이
   각각 최소 1개씩 있어야 한다. 완전한 결과만 `uniffi.output`을 교체한다. 생성 실패는
   기존 바인딩을 보존하고, 성공한 교체는 오래된 파일도 제거한다.

`--check`는 UniFFI의 `uniffi_generated.rs`만 비교하는 저비용 검사이며,
**Kotlin/Swift 신선도를 증명하지 않는다**. 전체 바인딩 CI 게이트는
`rustra codegen --check-bindings`로 명시 실행한다. 이 옵션은 `--check`를 포함하며
라이브러리 빌드와 빈 임시 디렉터리의 bindgen 생성을 거쳐 전체 경로와 바이트를 비교한다.
Swift·Kotlin·헤더·modulemap과 오래된 추가 파일까지 검사하고 커밋된 출력은 교체하지 않는다.
Cargo 타깃 디렉터리에 빌드 산출물은 쓸 수 있으며, 네이티브 빌드와 bindgen 실행 비용이 든다.

오케스트레이션 구현은 `packages/cli/src/cli-uniffi.ts`, 미러 렌더러는
`examples/calculator/src/uniffi_render.rs`(단위 테스트 11개 — 미러로
표현 불가능한 타입을 만나면 스키마 경로를 밝히며 실패한다, 조용한 skip
없음)이다.

## 5. Kotlin/Swift 소비

커맨드별 타입 함수가 최상위 함수로 생성된다. calculator 예제 기준(커밋된
바인딩: `examples/calculator/uniffi/`):

Kotlin(패키지 `uniffi.rustra_calculator_example`):

```kotlin
import uniffi.rustra_calculator_example.*

val sum = addNumbers(AddNumbersInput(a = 2, b = 3)) // AddNumbersOutput(value = 5)

try {
    divide(DivideInput(a = 10.0, b = 0.0))
} catch (e: RustraCommandFailure.Failure) {
    println(e.code) // "math.divide_by_zero"
}
```

Swift:

```swift
let sum = try addNumbers(input: AddNumbersInput(a: 2, b: 3)) // AddNumbersOutput(value: 5)

do {
    _ = try divide(input: DivideInput(a: 10, b: 0))
} catch let failure as RustraCommandFailure {
    if case let .Failure(code, detail, retryable) = failure {
        print(code) // "math.divide_by_zero"
    }
}
```

**에러 모델** — 단일 변형 실패 record
`RustraCommandFailure.Failure { code, detail, retryable }`(TS 의
`RustraCommandError` 와 동일 형태). rustra 의 에러 코드 공간은 열려 있으므로
(커스텀 코드 무제한), 코드를 폐쇄해야 하는 uniffi enum 매핑은 기각됐다.

제네릭 표면 3개도 함께 생성된다:

- `invokeJson(command, argsJson)` — 이름 기반 JSON 경로(`Package::invoke_json`
  의 문자열 경계 래퍼).
- `getSchema()` — 라이브 스키마(`Package::live_schema`). TS 쪽 스키마와 달리
  **세대 카운터가 포함**된다(핫스왑 관측용).
- `contractHash()` — FFI `rustra_ffi_contract_hash` 와 동일 단일 소스.

**로딩 모델** — uniffi 바인딩은 로드 시점에 cdylib 심볼을 바인딩한다. 따라서
이 표면은 **정적/릴리스 빌드 전용**이고, dylib 핫스왑(`hot-core`)과는 조합할
수 없다. dev 루프는 기존 TS/JSI 경로를 유지한다.

## 6. 런타임 스모크 하네스

생성된 바인딩은 실제 에뮬레이터/시뮬레이터 런타임에서 두 개의 커밋된 스모크
하네스로 증명되며, 둘 다 CI 잡으로 연결돼 있다(`.github/workflows/ci.yml`):

- **Android** — `examples/uniffi-android-smoke`: 생성된 Kotlin 바인딩
  (`uniffi.rustra_calculator_example`, JNA 기반)과 cargo-ndk 로 빌드한 Rust
  `.so` 를 로드하는 최소 Gradle 앱. 행복 경로 `addNumbers(20, 22) == 42` 와
  타입 에러 경로 `divide(10, 0)` → 코드 `"math.divide_by_zero"` 를 모두 증명한
  뒤에야 `__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42` 마커를 `Log.w` 로 찍는다.
  `uniffi-android` CI 잡이 x86_64 에뮬레이터를 부팅해 APK 를 설치하고 로그에서
  마커를 단언한다.
- **iOS** — `examples/uniffi-ios-smoke`: `build-and-run.sh` 가
  `aarch64-apple-ios-sim` 용 staticlib 를 빌드하고 `swiftc` 로 링크하며(FFI
  모듈 맵 등록), 시뮬레이터를 부팅해 `simctl` 로 스모크 바이너리를 spawn 한
  뒤 같은 마커를 단언한다. `uniffi-ios` CI 잡으로 실행된다.

이 하네스들이 바인딩 신선도 이야기의 런타임 절반이다: `--check-bindings` 바이트
비교(§4)는 커밋된 소스의 드리프트를 잡고, 스모크 앱은 로드/링크 시점에만 드러나는
것을 잡는다.

## 7. 제한과 문서화된 갈림

미러 타입 매핑에서 의도적으로 문서화된 기계적 갈림(전부 렌더러의 fail-closed
규칙 안에서 결정된다):

| 스키마 형태              | 미러 표현                                        | 변환                                   |
| ------------------------ | ------------------------------------------------ | -------------------------------------- |
| set                      | `Vec<T>`                                         | 상위 변환 시 실제 `BTreeSet` 으로 수집 |
| 고정 길이 튜플           | 합성 record(`SpanInputPair` 등, `v0`..`vn` 필드) | `From` 변환                            |
| map                      | `HashMap`/`BTreeMap`                             | 추론 기반 collect                      |
| `getSchema()`            | live_schema(TS 스키마와 달리 세대 카운터 포함)   | —                                      |
| 채널/리소스 핸들 newtype | `u32` 스칼라                                     | 명시적 경로 표에 있는 정의만 역래핑    |

그 외 Phase 1 제한:

- **에러** — 단일 변형 record(§5). `decode_frame_response` 통합 디코더의
  `internal: "<code>: <message>"` 합침 한계(§2).
- **식별자 정책** — 스키마에서 온 이름(타입·필드·enum 변형·커맨드명)은
  유효한 비키워드 Rust 식별자여야 한다. 렌더러는 나중에 rustc 가 불투명하게
  실패하는 대신 생성 시점에 정확한 스키마 경로와 함께 실패시킨다. 키워드
  이름을 raw 식별자로 이스케이프하지 **않는다** — uniffi 0.32 proc-macro 와
  Kotlin/Swift 생성기가 `r#` 를 안전하게 옮겨주지 않는다(에러 미러의
  `message`→`detail` 재명명이 유일한 의도된 갈림). snake 변환 후 같은 필드로
  겹치는 프로퍼티(예: `fooBar` + `foo_bar`)는 중복으로 거절된다.
- **비동기 미지원** — Rust 커맨드 API 가 현재 sync 이므로 생성 함수도 전부
  sync 다. `signal`/`timeoutMs` 같은 TS 옵션 표면은 이 경로에 없다.
- **이벤트/채널 제외** — Phase 2(uniffi callback interface + foreign trait).
- **XCFramework/AAR 발행 파이프라인** — 후속. Phase 1 은 로컬 빌드 + 생성
  바인딩 소스 검증까지다.

## 8. uniffi 버전 고정 정책

워크스페이스 의존은 `uniffi = "=0.32.1"` — **exact pin** 이다. 성숙도 조사
(`docs/research/2026-09-11-uniffi-maturity-catchup.md`)가 확인했듯 uniffi 는
minor 마다 생성 바인딩과 런타임 헬퍼의 정합성이 깨지는 churn 이 있고, 생성된
Kotlin 헬퍼는 컴파일된 Rust 컴포넌트와 **정확히 같은 버전**의 uniffi 를
요구한다. 버전을 올릴 때는 워크스페이스 핀을 한 곳에서 바꾸고, 같은 PR 에서
미러 소스와 커밋된 바인딩을 재생성한다 — `codegen --check-bindings`의 바이트 비교가
드리프트를 잡는다.

### 바인딩 출력 경계

`uniffi.output`은 바인딩 전용 디렉터리여야 한다. CLI는 Rust probe 실행 전에
경로를 정규화하여 schema·TypeScript 출력과의 중첩, Cargo manifest·Rust 소스 루트를
덮는 경로를 거부한다. `uniffi/` 또는 `src/bindings/`처럼 별도 하위 디렉터리를 사용한다.
전체 디렉터리를 교체하므로 수동 작성 파일을 함께 두지 않는다. 감시는 바인딩 출력과
그 교체용 임시 디렉터리를 제외한다.
