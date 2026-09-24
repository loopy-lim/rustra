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

// ── (S1) Rust 내부 타입명 누출 정화 — TS CLI(codegen-definitions.ts) 와 동일 규칙 ──
//
// schemars(`JsonSchema::schema_name`)이 명령 루트에 붙이는 원시/합성 이름이 TS
// 표면으로 그대로 흐르는 것(`export type String = string` — DX_AUDIT S1)을
// 판정한다. primitives.rs(simple_impl!/unsigned_impl!)·tuple.rs·sequences.rs·
// maps.rs 의 명명 규칙에서 역추출한 고정 집합이다.

/// schemars 가 원시 타입에 붙이는 스키마 이름(JSON format 이름 포함).
const SCHEMARS_PRIMITIVE_NAMES: &[&str] = &[
    "String",
    "Boolean",
    "Null",
    "Character",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "int128",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uint128",
    "float",
    "double",
    "ipv4",
    "ipv6",
    "ip",
    "Uuid",
];

/// schemars 합성 타입명 접두어 — `Vec<T>` 는 `Array_of_T`, `[T; N]` 은
/// `Array_size_N_of_T` 로 명명된다.
const SCHEMARS_COMPOSITION_PREFIXES: &[&str] = &[
    "Tuple_of_",
    "Array_of_",
    "Array_size_",
    "Array_up_to_size_",
    "Set_of_",
    "Map_of_",
    "Nullable_",
    "Result_of_",
    "Bound_of_",
    "Range_of_",
    "Either_",
];

/// Rust(schemars) 내부 타입명 누출 여부 — 이 이름은 commands_ts 시그니처에서
/// 인라인 타입으로 정화해 렌더링하고, types_ts 에서는 하위 호환 deprecated
/// alias 로만 남는다.
pub(super) fn is_rust_internal_type_name(name: &str) -> bool {
    SCHEMARS_PRIMITIVE_NAMES.contains(&name)
        || SCHEMARS_COMPOSITION_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// JS 전역 내장 타입명과의 충돌 여부 — deprecated alias 경고 문구용.
pub(super) fn is_js_builtin_type_name(name: &str) -> bool {
    matches!(
        name,
        "String"
            | "Boolean"
            | "Null"
            | "Number"
            | "Object"
            | "Symbol"
            | "BigInt"
            | "Function"
            | "Array"
            | "Promise"
    )
}

/// 스키마 트리에서 `$ref` 가 가리키는 정의 이름을 전부 모은다 — 인라인 렌더링이
/// 참조하는 정의(튜플 원소 구조체 등)를 commands_ts 의 import 목록에 올린다.
pub(super) fn collect_ref_type_names(schema: &Value, out: &mut BTreeSet<String>) {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        out.insert(
            reference
                .rsplit('/')
                .next()
                .unwrap_or(reference)
                .to_string(),
        );
        return;
    }
    let mut children: Vec<&Value> = Vec::new();
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        children.extend(all_of.iter());
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(choices) = schema.get(key).and_then(Value::as_array) {
            children.extend(choices.iter());
        }
    }
    if let Some(items) = schema.get("items") {
        match items {
            Value::Array(elements) => children.extend(elements.iter()),
            Value::Object(_) => children.push(items),
            _ => {}
        }
    }
    if let Some(prefix) = schema.get("prefixItems").and_then(Value::as_array) {
        children.extend(prefix.iter());
    }
    if let Some(Value::Object(properties)) = schema.get("properties") {
        children.extend(properties.values());
    }
    if let Some(additional) = schema
        .get("additionalProperties")
        .filter(|value| value.is_object())
    {
        children.push(additional);
    }
    for child in children {
        collect_ref_type_names(child, out);
    }
}

/// SHA-256 해시를 hex 문자열로 반환합니다.
///
/// 스키마 무결성 검증을 위한 `contract_hash` 생성에 사용합니다.
pub(crate) fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}

/// (M7) 생성 표면의 `InvokeOptions` 재노출에 붙는 취소 의미론 경고 —
/// TS CLI 렌더러(generate-commands.ts)의 INVOKE_OPTIONS_JS_DOC 과 동일 바이트.
///
/// 근거(docs/compatibility-matrix.md "Signal semantics in detail"): 얕은 취소
/// 어댑터에서 `signal` 은 JS 프라미스만 거부하고 Rust 실행은 계속되며,
/// `retryable: true`는 "재실행 안전"이 아니다(DX_AUDIT M7).
pub(super) const INVOKE_OPTIONS_JS_DOC: &str = r#"/**
 * 이 패키지 생성 명령의 호출 옵션 — 모든 생성 함수의 마지막 파라미터.
 *
 * ⚠️ **얕은 취소**: `signal` 이 실행 중에 abort 되면 **JS 프라미스만 거부되고**
 * (shallow cancellation) Rust 명령은 끝까지 실행되거나 이미 완료됐을 수 있습니다.
 * 취소/타임아웃은 "명령이 실행되지 않았음"을 보장하지 않습니다.
 *
 * ⚠️ **`retryable: true` ≠ 재실행 안전**: `transport.timeout`·`cancelled` 등
 * retryable 오류는 재시도 시 실패 유형이 사라질 수 있음을 뜻할 뿐, 명령을 다시
 * 실행해도 안전하다는 뜻이 아닙니다. 비멱등 명령의 재시도는 상태를 재조회해 이전
 * 시도가 반영되지 않았음을 확인한 뒤에만 하세요.
 *
 * 전체 의미론은 docs/compatibility-matrix.md "Signal semantics in detail" 및
 * 원본 타입(`InvokeOptions`(@rustra/types)) 문서를 참고하세요.
 */
"#;

/// (S1) 호출 규약 혼재 알림 — TS CLI 렌더러의 MIXED_CONVENTION_NOTE 과 동일 바이트.
pub(super) const MIXED_CONVENTION_NOTE: &str = r#"// ── 호출 규약 알림 ─────────────────────────────────────────────────
// 이 패키지는 두 호출 규약이 혼재합니다 — 시그니처로 구분하세요:
//   - positional 함수(PackageBuilder::function): 인자를 그대로 나열 — add(1, 2)
//   - struct 기반 명령(#[command]): 필드 객체 하나 — addNumbers({ a: 1, b: 2 })
// ─────────────────────────────────────────────────────────────────
"#;

/// (S1) Rust 내부 타입명 누출 별칭에 붙는 하위 호환 deprecated JSDoc —
/// TS CLI 렌더러(generate-surface.ts)의 deprecatedAliasJsDoc 과 동일 규칙.
pub(super) fn deprecated_alias_js_doc(name: &str) -> String {
    let collision = if is_js_builtin_type_name(name) {
        " 이 이름은 JS 내장 타입과 충돌하므로 특히 직접 import 하지 마세요."
    } else {
        ""
    };
    format!(
        "/**\n * @deprecated Rust 내부 타입명(`{name}`)이 그대로 노출된 레거시 별칭입니다.{collision}\n * 새 코드는 인라인 타입을 사용하세요 — 생성 명령 시그니처는 이미 정화됐고,\n * 이 별칭은 기존 코드 호환을 위해 유지됩니다.\n */\n"
    )
}
