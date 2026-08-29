/// JSON Schema [`Value`]를 TypeScript 타입 표현식으로 변환합니다.
///
/// 재귀적으로 `$ref`, `anyOf`, `object`, `array` 등을 처리합니다.
pub(super) fn ts_type_from_schema(schema: &Value, definitions: &Value) -> String {
    if let Some(r#ref) = schema.get("$ref").and_then(Value::as_str) {
        return resolve_ref(r#ref);
    }

    // allOf → intersection `A & B` (TS CLI codegen 과 동일 규칙).
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        let parts: Vec<String> = all_of
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return parts.join(" & ");
    }

    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        let parts: Vec<String> = any_of
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return parts.join(" | ");
    }

    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        let parts: Vec<String> = one_of
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        return parts.join(" | ");
    }

    match schema.get("type") {
        Some(Value::String(t)) => match t.as_str() {
            "object" => ts_object_from_schema(schema, definitions),
            "integer" => {
                // integer enum → `1 | 2 | 3` 리터럴 union (TS CLI codegen 과 일치).
                if let Some(enum_values) = schema.get("enum").and_then(Value::as_array) {
                    let variants: Vec<String> = enum_values
                        .iter()
                        .filter_map(|v| match v {
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        })
                        .collect();
                    if !variants.is_empty() {
                        return variants.join(" | ");
                    }
                }
                // int64/uint64 는 2^53 을 넘을 수 있다 — postcard fast-path 코덱
                // (uvar64/zigzag64)이 safe 범위를 넘으면 bigint 로 복원하므로
                // TS CLI codegen 과 동일하게 `number | bigint` 로 표현한다.
                if matches!(
                    schema.get("format").and_then(Value::as_str),
                    Some("int64") | Some("uint64")
                ) {
                    return "number | bigint".to_string();
                }
                "number".to_string()
            }
            "number" => "number".to_string(),
            "string" => {
                if let Some(enum_values) = schema.get("enum").and_then(Value::as_array) {
                    let variants: Vec<String> = enum_values
                        .iter()
                        .filter_map(|v| match v {
                            Value::String(s) => Some(format!("'{s}'")),
                            _ => None,
                        })
                        .collect();
                    if !variants.is_empty() {
                        return variants.join(" | ");
                    }
                }
                "string".to_string()
            }
            "boolean" => "boolean".to_string(),
            "array" => {
                if let Some(items) = schema.get("items").and_then(Value::as_array) {
                    let element_types: Vec<String> = items
                        .iter()
                        .map(|s| ts_type_from_schema(s, definitions))
                        .collect();
                    return format!("[{}]", element_types.join(", "));
                }
                let prefix = schema.get("prefixItems").and_then(Value::as_array);
                if let Some(items) = prefix {
                    let element_types: Vec<String> = items
                        .iter()
                        .map(|s| ts_type_from_schema(s, definitions))
                        .collect();
                    return format!("[{}]", element_types.join(", "));
                }
                // Vec<u8>의 공개 표면은 JSON(number[]), JS 바이너리(Uint8Array),
                // JSI 전용 경로(ArrayBuffer)를 모두 정직하게 표현한다.
                if schema
                    .get("items")
                    .and_then(Value::as_object)
                    .is_some_and(|items| {
                        items.get("type").and_then(Value::as_str) == Some("integer")
                            && items.get("format").and_then(Value::as_str) == Some("uint8")
                    })
                {
                    return "Uint8Array | ArrayBuffer | number[]".to_string();
                }
                let item_type = schema
                    .get("items")
                    .map(|s| ts_type_from_schema(s, definitions))
                    .unwrap_or_else(|| "unknown".to_string());
                // `uniqueItems: true` (Rust `BTreeSet`/`HashSet`)는 `Set<T>`로 매핑.
                // 와이어포맷은 배열 직렬화와 동일 — 런타임 변환은 생성된 코덱/호출부
                // 에서 `[...value]` / `new Set(...)` 로 처리한다.
                let unique = schema
                    .get("uniqueItems")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if unique {
                    return format!("Set<{item_type}>");
                }
                // union 요소 타입(`number | bigint`)은 괄호로 감싸지 않으면
                // `number | bigint[]` 로 잘못 결합된다 — TS CLI codegen 과 동일 규칙.
                if item_type.contains(" | ") {
                    return format!("({item_type})[]");
                }
                format!("{item_type}[]")
            }
            "null" => "null".to_string(),
            _ => "unknown".to_string(),
        },
        Some(Value::Array(types)) => {
            // `["integer","null"]` 같은 union — 요소가 integer 면 format(int64/
            // uint64)을 확인해 `number | bigint` 로 넓혀야 한다(A2/B1 이후 TS
            // CLI codegen 과 동일 규칙). 단일 integer 분기와 정확히 일치.
            let is_wide_integer = schema.get("format").and_then(Value::as_str) == Some("int64")
                || schema.get("format").and_then(Value::as_str) == Some("uint64");
            let parts: Vec<String> = types
                .iter()
                .filter_map(|t| t.as_str())
                .map(|t| match t {
                    "integer" => {
                        if is_wide_integer {
                            "number | bigint".to_string()
                        } else {
                            "number".to_string()
                        }
                    }
                    "number" => "number".to_string(),
                    "string" => "string".to_string(),
                    "boolean" => "boolean".to_string(),
                    "null" => "null".to_string(),
                    "object" => ts_object_from_schema(schema, definitions),
                    "array" => {
                        schema
                            .get("items")
                            .map(|s| ts_type_from_schema(s, definitions))
                            .unwrap_or_else(|| "unknown".to_string())
                            + "[]"
                    }
                    _ => "unknown".to_string(),
                })
                .collect();
            parts.join(" | ")
        }
        _ => "unknown".to_string(),
    }
}
