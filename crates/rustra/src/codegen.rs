//! TypeScript 코드 생성 유틸리티입니다.
//!
//! JSON Schema를 TypeScript 타입 표현식으로 변환하고,
//! 명령 이름을 lowerCamelCase 함수 이름으로 변환합니다.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

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
                    format!("Set<{item_type}>")
                } else {
                    format!("{item_type}[]")
                }
            }
            "null" => "null".to_string(),
            _ => "unknown".to_string(),
        },
        Some(Value::Array(types)) => {
            let parts: Vec<String> = types
                .iter()
                .filter_map(|t| t.as_str())
                .map(|t| match t {
                    "integer" | "number" => "number".to_string(),
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

/// JSON Schema object를 TypeScript 객체 타입 리터럴로 변환합니다.
///
/// `properties`의 각 필드를 `name: type;` 형식으로 생성하며,
/// `required`에 없는 필드는 `?` 선택적 필드로 표시합니다.
pub(super) fn ts_object_from_schema(schema: &Value, definitions: &Value) -> String {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        if let Some(additional) = schema.get("additionalProperties") {
            let value_type = ts_type_from_schema(additional, definitions);
            return format!("Record<string, {value_type}>");
        }
        return "Record<string, unknown>".to_string();
    };

    let fields = properties
        .iter()
        .map(|(name, property_schema)| {
            let optional = if required.contains(name.as_str()) {
                ""
            } else {
                "?"
            };
            let mut field_str = String::new();
            if let Some(desc) = property_schema.get("description").and_then(Value::as_str) {
                field_str.push_str(&format!("  /** {} */\n", desc.replace('\n', " ")));
            }
            field_str.push_str(&format!(
                "  {name}{optional}: {};",
                const_literal(property_schema)
                    .unwrap_or_else(|| ts_type_from_schema(property_schema, definitions))
            ));
            field_str
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!("{{\n{fields}\n}}")
}

/// `const` 키를 갖는 스키마의 TS 리터럴 표현 — string/number/boolean만 지원.
///
/// `#[serde(tag = "type")]` variant 가 schemars 에서 `type: { const: "A" }` 로
/// 내보내지므로, 이를 `'A'` 리터럴로 매핑해 `{ type: 'A' }` 판별 필드를 만든다.
fn const_literal(schema: &Value) -> Option<String> {
    let value = schema.get("const")?;
    match value {
        Value::String(s) => Some(format!("'{s}'")),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `$ref` 문자열에서 타입 이름을 추출합니다.
///
/// `#/definitions/Foo` → `Foo`, `#/$defs/Foo` → `Foo`
pub(super) fn resolve_ref(r#ref: &str) -> String {
    r#ref
        .strip_prefix("#/definitions/")
        .or_else(|| r#ref.strip_prefix("#/$defs/"))
        .unwrap_or(r#ref)
        .to_string()
}

/// 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다.
///
/// 비영숫자 문자를 구분자로 처리합니다.
/// 예: `addNumbers` → `addNumbers`, `do-something` → `doSomething`
pub(super) fn command_function_name(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if output.is_empty() {
                output.push(character.to_ascii_lowercase());
            } else if uppercase_next {
                output.push(character.to_ascii_uppercase());
            } else {
                output.push(character);
            }
            uppercase_next = false;
        } else {
            uppercase_next = true;
        }
    }

    if output.is_empty() {
        "command".to_string()
    } else {
        output
    }
}

/// snake_case, kebab-case, dot.case를 lowerCamelCase로 변환합니다.
///
/// 예: `add_numbers` → `addNumbers`, `my-command` → `myCommand`
pub(super) fn snake_to_lower_camel(name: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = false;

    for character in name.chars() {
        if character == '_' || character == '-' || character == '.' {
            uppercase_next = true;
            continue;
        }

        if output.is_empty() {
            output.push(character.to_ascii_lowercase());
        } else if uppercase_next {
            output.push(character.to_ascii_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }

    output
}

/// SHA-256 해시를 hex 문자열로 반환합니다.
///
/// 스키마 무결성 검증을 위한 `contract_hash` 생성에 사용합니다.
pub(crate) fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}
