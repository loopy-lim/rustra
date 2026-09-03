// ── (Tier 3 정합) JS postcard 코덱 지원 판정 미러 ─────────────
//
// @rustra/cli 의 classifyPostcardField(generate.ts)와 동일한 타입 집합을
// Rust 쪽에서 판정한다. JS 코드젠은 미지원 필드를 가진 명령을 rkyv-registry
// 에서 제외하고, 엔진은 그 명령을 Tier 3(JSON-in-binary) 로 라우팅한다.
// Rust 도 같은 판정으로 typed postcard fast-path 를 끄면 양쪽 와이어가
// 일치한다. 집합이 어긋나면 JS postcard ↔ Rust JSON 프레임 불일치가 되므로,
// JS 쪽 지원 범위를 확장할 때 이 함수를 함께 갱신해야 한다 (codegen 마감 조항).

/// 스키마(객체)의 모든 프로퍼티가 JS postcard 코덱 지원 타입인지 판정한다.
/// definitions 를 받는 확장 판정 — `$ref` 를 실제 정의 스키마까지 따라간다.
///
/// 과거 판정은 `$ref` 를 무조건 지원(struct)으로 취급했다(주석이 "단순화"라고
/// 자백). `$ref` 가 map/oneOf 같은 미지원 타입을 가리키면 Rust 는 typed
/// fast-path 를 켜고 JS 는 다른 인코딩을 써서 런타임 디코딩이 깨진다 — 여기서
/// 정의를 따라가 재검증해 그 조합을 Tier 3 로 밀어낸다.
pub(crate) fn js_postcard_codec_supported_with_defs(schema: &Value, definitions: &Value) -> bool {
    let defs = definitions.as_object();
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return true;
    };
    props
        .values()
        .all(|p| js_field_supported_with_defs(p, defs, 0))
}

fn resolve_ref<'a>(
    schema: &'a Value,
    defs: Option<&'a serde_json::Map<String, Value>>,
) -> &'a Value {
    let Some(name) = schema.get("$ref").and_then(Value::as_str) else {
        return schema;
    };
    // JSON Schema $ref 형태 "#/definitions/Name"(또는 $defs) 에서 마지막 세그먼트로
    // 조회한다. 못 찾으면 원본을 그대로 반환 — 판정은 이어서 안전하게 실패한다.
    let key = name.rsplit('/').next().unwrap_or(name);
    defs.and_then(|d| d.get(key)).unwrap_or(schema)
}

fn js_field_supported_with_defs(
    schema: &Value,
    defs: Option<&serde_json::Map<String, Value>>,
    depth: u8,
) -> bool {
    if depth > 8 {
        return false; // 과도한 중첩(순환 $ref 포함) — 안전하게 미지원 취급
    }
    // int64/uint64 는 TS CLI 의 uvar64/zigzag64 64-bit 헬퍼로 postcard
    // fast-path 에 합류했다(@rustra/cli classifyPostcardField 와 동일 판정).
    // safe 범위를 넘는 값은 number 대신 bigint 로 복원된다.
    // Set-shaped arrays are owned by the complex route, which restores Set
    // semantics at the JS boundary instead of exposing an array.
    if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
        return false;
    }
    // schemars의 tuple newtype는 single-entry allOf + $ref다. serde/postcard는
    // 내부 값만 직렬화하므로 이 한 겹은 투명하게 벗길 수 있다. 둘 이상의
    // allOf(intersection)는 와이어 순서를 증명할 수 없어 계속 미지원이다.
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        if all_of.len() == 1 {
            return js_field_supported_with_defs(&all_of[0], defs, depth + 1);
        }
        return false;
    }
    // $ref → 정의 스키마를 따라가 판정한다. 정의를 못 찾으면 원본 스키마로
    // 폴백해 아래 규칙이 그대로 적용된다(과거 동작과 동일하게 안전 실패).
    if schema.get("$ref").is_some() {
        let resolved = resolve_ref(schema, defs);
        if !std::ptr::eq(resolved, schema) {
            return js_field_supported_with_defs(resolved, defs, depth + 1);
        }
        return true; // 정의 미발견 — 기존 "struct 로 취급" 동작 유지
    }
    // anyOf 의 [{$ref}, null] 형태(Option<Struct>)도 정의를 따라간다.
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        let has_null = any_of
            .iter()
            .any(|s| s.get("type") == Some(&Value::String("null".into())));
        let ref_schemas: Vec<&Value> = any_of.iter().filter(|s| s.get("$ref").is_some()).collect();
        if has_null && ref_schemas.len() == 1 && any_of.len() == 2 {
            let resolved = resolve_ref(ref_schemas[0], defs);
            if !std::ptr::eq(resolved, ref_schemas[0]) {
                return js_field_supported_with_defs(resolved, defs, depth + 1);
            }
            return true;
        }
        return false;
    }
    // 배열 — tuple(items 배열)을 단일 items 보다 먼저 판정한다. schemars 튜플
    // 표현은 items 가 배열 + min/maxItems(probe 실증). 요소 전체 지원 시 지원.
    if schema.get("type").and_then(Value::as_str) == Some("array") {
        if let Some(items) = schema.get("items").and_then(Value::as_array) {
            return items
                .iter()
                .all(|it| js_field_supported_with_defs(it, defs, depth + 1));
        }
        if let Some(items) = schema.get("items") {
            if items.get("$ref").is_some() {
                let resolved = resolve_ref(items, defs);
                if !std::ptr::eq(resolved, items) {
                    return js_field_supported_with_defs(resolved, defs, depth + 1);
                }
                return true;
            }
            // Vec<u8> 등 원시 벡터 — scalar 지원 여부와 int64 범위를 함께 검사한다.
            return js_field_supported_with_defs(items, defs, depth + 1);
        }
        return false;
    }
    // object(struct) — 프로퍼티 전체를 재귀 판정한다. $ref 해결로 도달한
    // 중첩 구조체가 여기서 false 폴백에 걸려 Tier 3 로 잘못 밀려지는 일을 막는다.
    // additionalProperties (properties 없음) 는 동적 맵 — 원시값 맵만 지원.
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        if let Some(v) = schema.get("additionalProperties") {
            if schema.get("properties").is_some() {
                return false; // 혼합 형태 — 미지원
            }
            return js_field_supported_with_defs(v, defs, depth + 1)
                && !matches!(
                    v.get("type").and_then(Value::as_str),
                    Some("object") | Some("array")
                );
        }
        let Some(props) = schema.get("properties").and_then(Value::as_object) else {
            return true; // 빈 객체
        };
        return props
            .values()
            .all(|p| js_field_supported_with_defs(p, defs, depth + 1));
    }
    // oneOf — payload enum. postcard variant index 는 선언순이나 schemars oneOf 는
    // unit variant 를 앞으로 재배치(probe 실증)해 스키마만으로 복원 불가 → 미지원.
    if schema.get("oneOf").is_some() {
        return false;
    }
    js_field_supported(schema, depth)
}
