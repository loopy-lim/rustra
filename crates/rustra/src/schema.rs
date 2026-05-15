//! 스키마 생성 및 타입 리플렉션 유틸리티입니다.

use schemars::JsonSchema;
use serde_json::Value;
use std::any::type_name;

use crate::codegen::snake_to_lower_camel;

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
/// `__` 접두사가 있으면 제거합니다 (매크로에서 생성한 내부 타입).
pub(super) fn short_type_name<T>() -> String {
    let name = type_name::<T>()
        .rsplit("::")
        .next()
        .expect("type name has a final segment");
    name.strip_prefix("__").unwrap_or(name).to_string()
}

/// 핸들러 함수 타입 `F`의 이름에서 커맨드 이름을 추출합니다.
///
/// `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환합니다.
/// 예: `add_numbers_command` → `addNumbers`
pub(super) fn command_name_from_handler<F>() -> String {
    let raw = short_type_name::<F>();
    snake_to_lower_camel(raw.trim_end_matches("_command"))
}
