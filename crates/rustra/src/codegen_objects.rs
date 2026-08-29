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
