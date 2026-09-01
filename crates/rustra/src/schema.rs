//! 스키마 생성 및 타입 리플렉션 유틸리티입니다.

use schemars::JsonSchema;
use serde_json::Value;
use std::any::type_name;

use rustra_naming::snake_to_lower_camel;

/// 타입 `T`의 JSON Schema를 (루트 스키마, definitions) 튜플로 직렬화합니다.
pub(super) fn schema_value<T>() -> (Value, Value)
where
    T: JsonSchema,
{
    let schema = schemars::schema_for!(T);
    let root = serde_json::to_value(schema.schema).expect("schema serializes");
    let defs = serde_json::to_value(schema.definitions).expect("definitions serialize");
    (root, defs)
}

/// `std::any::type_name`에서 마지막 세그먼트만 추출합니다.
///
/// 예: `"my_crate::AddNumbersInput"` → `"AddNumbersInput"`
pub(super) fn short_type_name<T>() -> String {
    type_name::<T>()
        .rsplit("::")
        .next()
        .expect("type name has a final segment")
        .to_string()
}

/// 명령 입출력 타입의 계약 이름 — schemars의 [`JsonSchema::schema_name`]과 단일 소스.
///
/// `type_name`의 마지막 세그먼트는 제네릭에서 `Wrapper<String >` 꼴(비식별자)로
/// 파손되지만, `schema_name()`은 구체 인스턴스마다 유효 식별자를 반환한다
/// (schemars derive의 모노몰포이즈: `Wrapper_for_String`).
/// 이 이름은 루트 스키마 `title`과 definitions 키가 만들어지는 근원이므로,
/// inputType/outputType을 여기에 맞추면 CLI 검증·TS/C++ 렌더러·코덱 IR이
/// 별도 수정 없이 하나의 이름으로 묶인다.
pub(super) fn contract_type_name<T>() -> String
where
    T: JsonSchema,
{
    <T as JsonSchema>::schema_name()
}

/// 핸들러 함수 타입 `F`의 이름에서 커맨드 이름을 추출합니다.
///
/// `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환합니다.
/// 예: `add_numbers_command` → `addNumbers`
pub(super) fn command_name_from_handler<F>() -> String {
    let raw = short_type_name::<F>();
    snake_to_lower_camel(raw.trim_end_matches("_command"))
}
