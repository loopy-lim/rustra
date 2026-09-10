// ── hot-core 스왑 시나리오 변형 cdylib (실험적) ──────────────────────────────
//
// hot-core 감시 스왑의 교체 단위로 쓰는 최소 패키지다. calculator 예제와 같은
// cdylib FFI 노출 메커니즘을 재현한다:
//
//   `#[command]` 매크로 → `register!(Package::builder(id), ...).build()` →
//   `register_ffi_with_default(FfiFormat::Json)`(전역 FFI 컨텍스트 등록 —
//   OnceLock first-wins) → `rustra::native_entry!` 가 `rustra_mobile_init`
//   심볼과 Apple 로드 시점 constructor 를 설치.
//
// dlopen 측(`DylibCore::open`)은 `rustra_ffi_invoke_json` /
// `rustra_ffi_contract_hash` / `rustra_ffi_free` 를 rustra rlib 의
// `#[no_mangle]` 표면에서 바인딩한다 — cdylib 은 의존 rlib 의 no_mangle 심볼을
// 그대로 export 하므로 예제 측 재노출 래퍼가 필요 없다.
//
// feature 조합이 곧 스왑 시나리오다(Cargo.toml features 주석 참고):
//
//   | feature     | 와이어 변화                       | 계약 해시 |
//   | ----------- | --------------------------------- | --------- |
//   | (없음)      | addNumbers {a,b} → {value}        | 기준      |
//   | behavior    | 본문만 a+b+100 (스키마 동일)      | 기준과 동일 |
//   | add-cmd     | multiplyNumbers 추가              | 변함      |
//   | rename-cmd  | addNumbers → addNumbersV2         | 변함      |
//   | sig-change  | 입력에 c: i64 추가                | 변함      |

use rustra::prelude::*;

/// addNumbers 입력. `sig-change` 에서만 필드 c 가 붙는다 — 스키마(나아가 계약
/// 해시)가 변하는 시나리오 4의 유일한 지점이다.
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
    #[cfg(feature = "sig-change")]
    pub c: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}

// `rename-cmd` 는 등록 이름 자체를 바꾼다 — 구 이름(addNumbers)의 소멸과 신
// 이름(addNumbersV2)의 등장을 한 번에 관측하기 위해 정의를 feature 로 갈아끼운다.
#[cfg(not(feature = "rename-cmd"))]
#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    let sum = input.a + input.b;
    // `behavior` 는 본문만 바꾼다 — 입력/출력 스키마는 그대로이므로 계약 해시가
    // 불변인 상태에서 데이터가 변한다("로직 변경은 자유 스왑"의 실측 유닛).
    #[cfg(feature = "behavior")]
    let sum = sum + 100;
    // `sig-change` 가 추가한 필드는 본문에서도 소비한다 — 시그니처와 로직이
    // 함께 변하는 경우의 와이어 관측용.
    #[cfg(feature = "sig-change")]
    let sum = sum + input.c;
    Ok(AddNumbersOutput { value: sum })
}

#[cfg(feature = "rename-cmd")]
#[command]
pub fn add_numbers_v2(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    let sum = input.a + input.b;
    #[cfg(feature = "behavior")]
    let sum = sum + 100;
    #[cfg(feature = "sig-change")]
    let sum = sum + input.c;
    Ok(AddNumbersOutput { value: sum })
}

// `add-cmd` — 스키마가 늘어나는(해시가 변하는) 추가 명령.
#[cfg(feature = "add-cmd")]
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[cfg(feature = "add-cmd")]
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyNumbersOutput {
    pub value: i64,
}

#[cfg(feature = "add-cmd")]
#[command]
pub fn multiply_numbers(input: MultiplyNumbersInput) -> Result<MultiplyNumbersOutput> {
    Ok(MultiplyNumbersOutput {
        value: input.a * input.b,
    })
}

static CACHED_PACKAGE: std::sync::OnceLock<Package> = std::sync::OnceLock::new();

/// 스왑 유닛 패키지 — calculator 의 `calculator_package()` 와 동일한 골격
/// (OnceLock 캐시 → register! → FFI 등록)이다.
pub fn variant_package() -> Package {
    CACHED_PACKAGE
        .get_or_init(|| {
            // rename-cmd 의 갈아끼움 — 등록 목록의 첫 항목이 addNumbers 대신
            // addNumbersV2 가 된다.
            #[cfg(not(feature = "rename-cmd"))]
            let builder = register!(Package::builder("examples.hotvariant"), add_numbers);
            #[cfg(feature = "rename-cmd")]
            let builder = register!(Package::builder("examples.hotvariant"), add_numbers_v2);

            // 신규 커맨드는 체인 맨 뒤에 붙인다(calculator 의 register! id 순서
            // 계약과 동일한 관용).
            #[cfg(feature = "add-cmd")]
            let builder = builder.command_fn(multiply_numbers);

            let pkg = builder.build();

            // FFI 전역 컨텍스트 등록 — rustra_ffi_invoke_json / contract_hash 가
            // 읽는 상태다(calculator 와 동일, Json 기본 포맷).
            pkg.register_ffi_with_default(rustra::ffi::FfiFormat::Json);

            pkg
        })
        .clone()
}

// rustra_mobile_init 심볼 + Apple 로드 시점 constructor 설치. DylibCore::open 이
// dlopen 직후 호출하는 엔트리다.
rustra::native_entry!(variant_package);
