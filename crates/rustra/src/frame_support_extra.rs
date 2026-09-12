fn js_field_supported(schema: &Value, depth: u8) -> bool {
    if depth > 8 {
        return false; // 과도한 중첩 — 안전하게 미지원 취급
    }
    if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
        return false;
    }
    // string-only enum → 지원 (variant index varint)
    if schema.get("type").and_then(Value::as_str) == Some("string") {
        return true;
    }
    // Option<T> — type: ["T","null"] 또는 anyOf: [T, null].
    // probe: Option<u32> 는 `type:["integer","null"], format:"uint32"` —
    // format 이 상위에 유지되므로 inner 도 일반 스칼라 판정으로 충분하다.
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        let non_null: Vec<&str> = types
            .iter()
            .filter_map(Value::as_str)
            .filter(|t| *t != "null")
            .collect();
        if non_null.len() == 1 {
            let inner_type = non_null[0];
            // JS option_* kind 지원 집합: zigzag/uvar/f64/f32/bool/string/struct/bytes
            return matches!(inner_type, "integer" | "number" | "boolean" | "string");
        }
        return false;
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        // [{$ref}, {type:null}] 형태의 Option<Struct> → 지원
        let has_null = any_of
            .iter()
            .any(|s| s.get("type") == Some(&Value::String("null".into())));
        let refs = any_of.iter().filter(|s| s.get("$ref").is_some()).count();
        if has_null && refs == 1 && any_of.len() == 2 {
            return true;
        }
        return false;
    }
    // payload 있는 enum(oneOf) — 미지원. postcard variant index 는 Rust 선언순이나
    // schemars oneOf 는 unit variant 를 앞으로 재배치해(probe 실증) 선언순 복원
    // 불가 — Tier 3(JSON-in-binary) 로만 계약이 성립한다.
    if schema.get("oneOf").is_some() {
        return false;
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("boolean") | Some("number") | Some("string") => true,
        Some("integer") => true, // int64/uint64 포함 — uvar64/zigzag64 헬퍼로 지원
        Some("array") => {
            // tuple — items 가 배열 + minItems === maxItems(프로브: schemars
            // 튜플 표현). 모든 요소가 지원 타입일 때만 지원.
            if let Some(items) = schema.get("items").and_then(Value::as_array) {
                return items.iter().all(|it| js_field_supported(it, depth + 1));
            }
            let Some(items) = schema.get("items") else {
                return false;
            };
            if items.get("$ref").is_some() {
                return true; // Vec<Struct> → vec_struct
            }
            matches!(
                items.get("type").and_then(Value::as_str),
                Some("integer") | Some("number") | Some("boolean") | Some("string")
            )
        }
        Some("object") => {
            // dynamic map HashMap<String, 원시값> — 지원. 구조체/배열 값 맵은 미지원.
            if let Some(v) = schema.get("additionalProperties") {
                if v.get("properties").is_some() || v.get("items").is_some() {
                    return false;
                }
                return matches!(
                    v.get("type").and_then(Value::as_str),
                    Some("integer") | Some("number") | Some("boolean") | Some("string")
                );
            }
            false
        }
        _ => false, // 그 외 — JS 코덱 미지원
    }
}
