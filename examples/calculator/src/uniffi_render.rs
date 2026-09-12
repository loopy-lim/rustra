// UniFFI 미러 렌더러 — `generate_typescript()` 의 schema_json 을 읽어
// `src/uniffi_generated.rs` 소스를 렌더링한다(Track B1-2).
//
// 설계 계약:
// - 스키마 walk 중 미러로 표현 불가능한 타입을 만나면 스키마 경로를 밝히며 Err
//   — 조용한 skip 이 없다(fail-closed).
// - 필드 순서는 스키마(= Rust 선언 순서, schemars preserve_order)를 그대로
//   따른다. postcard 와이어 계약과 미러 Record 필드 순서가 같은 원천에서 온다.
// - 실제 타입 매핑 규칙: 정의 이름 N → `crate::N`(example lib 루트 선언).
//   예외: serde 표면이 plain u32 로 축소되는 채널/리소스 핸들 정의만
//   [`SCALAR_NEWTYPE_REAL_PATHS`] 표로 `rustra::channels::*` 를 가리킨다.
// - 미러 타입은 `pub mod uniffi_api` 안에 원래 이름 그대로 둔다(크레이트 루트
//   이름과 충돌하지 않아 접미사 불필요). uniffi 0.32 proc-macro 는 인라인
//   모듈 안의 Record/Enum/`#[uniffi::export]` 를 지원하며 `setup_scaffolding!()`
//   만 크레이트 루트에 둔다(스파이크 /tmp/uniffi-modtest 로 검증한 배치).
// - 이 모듈은 코드젠(generate bin) 전용이다. 런타임에 호출되지 않지만 example
//   lib 의 일부로 컴파일되어 단위 테스트가 붙는다(uniffi feature 불필요).

use serde_json::Value;

/// 렌더 실패 — 어느 스키마 경로에서 무엇이 막혔는지 담는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderError {
    /// 실패한 스키마 위치(예: `commands[kindEcho].inputSchema.properties.kind`).
    pub path: String,
    /// 실패 사유.
    pub reason: String,
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "uniffi render failed at {}: {}", self.path, self.reason)
    }
}

impl std::error::Error for RenderError {}

/// serde 표면이 plain 스칼라로 축소되는 정의의 실제 타입 경로 표.
///
/// `ChannelHandle`/`ResourceHandle` 은 uniffi 미러에서 스칼라(u32)로 인라인되고
/// 상위 구조체 변환에서 newtype 으로 래핑/언래핑된다. 이 표에 없는 스칼라 정의가
/// 등장하면 렌더러는 Err — 임의 newtype 을 추측하지 않는다.
const SCALAR_NEWTYPE_REAL_PATHS: &[(&str, &str)] = &[
    ("ChannelHandle", "rustra::channels::ChannelHandle"),
    ("ResourceHandle", "rustra::channels::ResourceHandle"),
];

/// Rust 2024 에디션의 예약어(strict + reserved). 스키마에서 온 이름이 여기
/// 있으면 미러가 그 이름으로는 선언 불가능하다 — raw 식별자(`r#type`)는 문법상
/// 유효하지만 uniffi 0.32 proc-macro 와 Kotlin/Swift 생성기가 `r#` 접두를
/// 안전하게 다뤄준다는 보장이 없다(`message`→`detail` 회피가 그 증거). 임의
/// 재명명은 실제 타입(`crate::{name}`)과의 1:1 대응을 깨므로 하지 않는다.
const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "become", "box", "break", "const", "continue", "crate", "do", "dyn",
    "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl", "in", "let",
    "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "raw", "ref",
    "return", "self", "Self", "static", "struct", "super", "trait", "true", "try", "type",
    "typeof", "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];

/// 스키마에서 온 이름이 미러가 선언할 수 있는 Rust 식별자인지 검증한다.
/// 이름은 코드젠 산출물 안에서 rustc 보다 먼저 — 정확한 스키마 경로와 함께 —
/// 실패시키기 위한 것이다(유효 스키마의 출력은 바뀌지 않는다).
fn ensure_rust_ident(kind: &str, name: &str, path: &str) -> Result<(), RenderError> {
    let reason = if name.is_empty() {
        format!("{kind} name is empty")
    } else if name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '_'))
    {
        format!(
            "{kind} name `{name}` is not a valid Rust identifier \
             (ASCII alphanumerics and `_` only)"
        )
    } else if name.starts_with(|c: char| c.is_ascii_digit()) {
        format!("{kind} name `{name}` starts with a digit")
    } else if RUST_KEYWORDS.contains(&name) {
        format!(
            "{kind} name `{name}` is a Rust keyword — the mirror cannot declare it \
             (raw identifiers are not carried safely through uniffi 0.32 proc-macros \
             and foreign generators); rename it on the Rust side"
        )
    } else {
        return Ok(());
    };
    Err(RenderError {
        path: path.to_string(),
        reason,
    })
}

/// 렌더 엔트리 포인트 — schema_json 을 미러 Rust 소스로 바꾼다.
///
/// 반환 소스는 `src/uniffi_generated.rs` 로 쓰이고 `#[cfg(feature = "uniffi")]`
/// 인 `include!` 로 lib.rs 에 붙는다. 렌더러 자체는 uniffi 크레이트를
/// 필요로 하지 않는다(텍스트 생성만).
pub fn render_uniffi_generated(schema_json: &str) -> Result<String, RenderError> {
    let doc: Value = serde_json::from_str(schema_json).map_err(|error| RenderError {
        path: "$".to_string(),
        reason: format!("schema_json parse failed: {error}"),
    })?;
    let mut renderer = Renderer::default();
    let commands = doc
        .get("commands")
        .and_then(Value::as_array)
        .ok_or_else(|| RenderError {
            path: "$.commands".to_string(),
            reason: "schema document has no commands array".to_string(),
        })?;
    for command in commands {
        renderer.collect_command(command)?;
    }
    Ok(renderer.emit())
}

/// 단순 스칼라 — 미러 토큰과 실제 토큰. 대부분 동일하지만 uniffi 가 지원하지
/// 않는 usize/isize 는 u64/i64 미러 + 변환 경계의 cast 로 표현한다.
#[derive(Debug, Clone, Copy)]
struct ScalarType {
    mirror: &'static str,
    real: &'static str,
}

/// 미러 필드 타입 표현식. 스키마 노드 하나의 해석 결과며 미러→실제(m2r) /
/// 실제→미러(r2m) 양방향 변환식을 함께 유도한다.
#[derive(Debug, Clone)]
enum TypeExpr {
    /// bool / 정수 / 실수 / String — 대부분 항등 변환(usize/isize 만 cast).
    Scalar(ScalarType),
    /// `pub mod uniffi_api` 안의 미러 Record/Enum 참조(defs 인덱스).
    Mirror(usize),
    /// plain 스칼라 표면의 핸들 정의(defs 인덱스) — 미러 필드는 스칼라.
    Newtype(usize),
    Vec(Box<TypeExpr>),
    Option(Box<TypeExpr>),
    /// 동적 맵 — 스키마 `object + additionalProperties`. 미러는 `HashMap`.
    Map(Box<TypeExpr>),
    /// 셋 — 스키마 `array + uniqueItems`. uniffi 는 셋을 지원하지 않으므로
    /// 미러는 `Vec` 으로 표현하고 변환에서 실제 `BTreeSet` 으로 모은다
    /// (경계 표현이 실제 타입과 다르다는 점을 문서화한 선택).
    Set(Box<TypeExpr>),
    /// 고정 길이 튜플 — uniffi 는 튜플을 지원하지 않으므로 합성 Record 미러
    /// (필드 v0..vn, 실제 타입은 Rust 튜플)를 만들어 참조한다.
    Tuple(usize),
}

/// 수집된 정의 — 공유 definitions + 커맨드 입출력 구조체 + 합성 튜플 레코드.
#[derive(Debug)]
enum DefIr {
    /// `#[derive(uniffi::Record)]` 구조체. `real_ty` 는 변환 대상 실제 타입
    /// 토큰(일반 구조체는 `crate::Name`, 합성 튜플은 `(A, B)`).
    Record {
        name: String,
        real_ty: String,
        fields: Vec<FieldIr>,
    },
    /// `#[derive(uniffi::Enum)]` — unit + struct 변형(외부 태그 oneOf 스키마).
    Enum {
        name: String,
        real_ty: String,
        variants: Vec<VariantIr>,
    },
    /// 스칼라 표면 핸들 정의 — 미러 타입을 만들지 않고 필드에서 스칼라로
    /// 인라인되며 상위 변환이 `real_path` newtype 으로 감싼다.
    Scalar {
        name: String,
        scalar: ScalarType,
        real_path: String,
    },
}

#[derive(Debug)]
struct FieldIr {
    /// 미러 필드명 — 실제 Rust 필드명과 같은 snake_case(스키마는 camelCase).
    name: String,
    expr: TypeExpr,
}

#[derive(Debug)]
struct VariantIr {
    name: String,
    fields: Vec<FieldIr>,
}

#[derive(Debug)]
struct CommandIr {
    /// camelCase 커맨드 이름 — 그대로 export 함수명이 된다.
    name: String,
    /// 입력 미러 타입명. `None` = unit 입력(`()` — 파라미터 없는 export).
    input: Option<String>,
    output: String,
}

/// 렌더러 상태 — 정의는 최초 등장 순서를 유지한다(결정론적 출력).
#[derive(Debug, Default)]
struct Renderer {
    defs: Vec<DefIr>,
    /// 정의 이름 → defs 인덱스.
    index: std::collections::HashMap<String, usize>,
    commands: Vec<CommandIr>,
}

impl Renderer {
    fn error(&self, path: impl Into<String>, reason: impl Into<String>) -> RenderError {
        RenderError {
            path: path.into(),
            reason: reason.into(),
        }
    }

    fn lookup(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }

    /// schema 문서의 커맨드 한 건을 수집한다.
    fn collect_command(&mut self, command: &Value) -> Result<(), RenderError> {
        let name = command
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| self.error("$.commands[].name", "command has no name"))?
            .to_string();
        let empty_defs = Value::Object(serde_json::Map::new());
        let defs = command.get("definitions").unwrap_or(&empty_defs);
        let base = format!("commands[{name}]");
        ensure_rust_ident("command", &name, &format!("$.{base}.name"))?;

        // 입력 — `{"title":"Null","type":"null"}` 은 unit 입력 핸들러(파라미터 없음).
        let input = match command.get("inputSchema") {
            Some(schema) if schema.get("type").and_then(Value::as_str) == Some("null") => None,
            Some(schema) => {
                let type_name = command
                    .get("inputType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| self.error(format!("{base}.inputType"), "missing inputType"))?;
                let idx =
                    self.ensure_def(type_name, schema, defs, &format!("{base}.inputSchema"))?;
                Some(self.def_name(idx))
            }
            None => return Err(self.error(format!("{base}.inputSchema"), "missing inputSchema")),
        };

        let output = {
            let schema = command.get("outputSchema").ok_or_else(|| {
                self.error(format!("{base}.outputSchema"), "missing outputSchema")
            })?;
            let type_name = command
                .get("outputType")
                .and_then(Value::as_str)
                .ok_or_else(|| self.error(format!("{base}.outputType"), "missing outputType"))?;
            let idx = self.ensure_def(type_name, schema, defs, &format!("{base}.outputSchema"))?;
            self.def_name(idx)
        };

        self.commands.push(CommandIr {
            name,
            input,
            output,
        });
        Ok(())
    }

    /// 명명된 정의(Record/Enum/스칼라 핸들)를 수집한다. 중복 호출은 안전하고
    /// 최초 등장 순서를 유지한다.
    fn ensure_def(
        &mut self,
        name: &str,
        schema: &Value,
        defs: &Value,
        path: &str,
    ) -> Result<usize, RenderError> {
        ensure_rust_ident("type", name, path)?;
        if let Some(idx) = self.lookup(name) {
            return Ok(idx);
        }
        let idx = self.defs.len();
        // 재귀 $ref(정의 → 정의)가 같은 슬롯을 재귀적으로 채우지 않도록 먼저
        // 슬롯을 예약하고 index 를 등록한 뒤 실제 변형을 만든다.
        self.defs.push(DefIr::Record {
            name: name.to_string(),
            real_ty: String::new(),
            fields: Vec::new(),
        });
        self.index.insert(name.to_string(), idx);
        let built = self.build_def(name, schema, defs, path)?;
        self.defs[idx] = built;
        Ok(idx)
    }

    /// 단일 정의를 스키마 모양(oneOf / object / plain scalar)에 따라 분류한다.
    fn build_def(
        &mut self,
        name: &str,
        schema: &Value,
        defs: &Value,
        path: &str,
    ) -> Result<DefIr, RenderError> {
        if schema.get("oneOf").is_some() {
            return self.build_enum_def(name, schema, defs, path);
        }
        if schema.get("type").and_then(Value::as_str) == Some("object") {
            return self.build_record_def(name, schema, defs, path);
        }
        if let Some(scalar) = scalar_token(schema, path)? {
            let real_path = SCALAR_NEWTYPE_REAL_PATHS
                .iter()
                .find(|(candidate, _)| *candidate == name)
                .map(|(_, real_path)| (*real_path).to_string())
                .ok_or_else(|| {
                    self.error(
                        path,
                        format!(
                            "scalar-shaped definition `{name}` has no real-type mapping; \
                             extend SCALAR_NEWTYPE_REAL_PATHS"
                        ),
                    )
                })?;
            return Ok(DefIr::Scalar {
                name: name.to_string(),
                scalar,
                real_path,
            });
        }
        Err(self.error(path, format!("unsupported definition shape for `{name}`")))
    }

    /// properties 맵 → 필드 IR. snake 변환 결과의 식별자 검증과 중복 선언
    /// 검출을 같은 경계에서 수행한다(레코드 필드·변형 페이로드 공용).
    fn collect_fields(
        &mut self,
        properties: &serde_json::Map<String, Value>,
        defs: &Value,
        path: &str,
        owner: &str,
    ) -> Result<Vec<FieldIr>, RenderError> {
        let mut fields = Vec::with_capacity(properties.len());
        let mut seen = Vec::with_capacity(properties.len());
        for (field, field_schema) in properties {
            let field_path = format!("{path}.properties.{field}");
            // 스키마 camelCase → 실제 Rust 필드명과 같은 snake_case.
            let snake = camel_to_snake(field);
            ensure_rust_ident("field", &snake, &field_path)?;
            if seen.contains(&snake) {
                return Err(RenderError {
                    path: field_path,
                    reason: format!(
                        "property `{field}` maps to field `{snake}` which is already \
                         declared in `{owner}` — the mirror cannot declare duplicates"
                    ),
                });
            }
            seen.push(snake.clone());
            let expr = self.type_expr(field_schema, defs, &field_path, owner, field)?;
            fields.push(FieldIr { name: snake, expr });
        }
        Ok(fields)
    }

    fn build_record_def(
        &mut self,
        name: &str,
        schema: &Value,
        defs: &Value,
        path: &str,
    ) -> Result<DefIr, RenderError> {
        if schema.get("additionalProperties").is_some() {
            return Err(self.error(
                path,
                format!("definition `{name}` mixes properties and additionalProperties"),
            ));
        }
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                self.error(
                    path,
                    format!("object definition `{name}` has no properties"),
                )
            })?;
        let fields = self.collect_fields(properties, defs, path, name)?;
        Ok(DefIr::Record {
            name: name.to_string(),
            real_ty: format!("crate::{name}"),
            fields,
        })
    }

    /// oneOf + `x-rustra-variant-order` → 데이터 동반 enum 미러.
    fn build_enum_def(
        &mut self,
        name: &str,
        schema: &Value,
        defs: &Value,
        path: &str,
    ) -> Result<DefIr, RenderError> {
        // 변형 순서의 단일 소스는 x-rustra-variant-order(Rust 선언 순서 계약).
        let order = schema
            .get("x-rustra-variant-order")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                self.error(
                    path,
                    format!("enum definition `{name}` lacks x-rustra-variant-order"),
                )
            })?;
        let one_of = schema
            .get("oneOf")
            .and_then(Value::as_array)
            .ok_or_else(|| self.error(path, format!("enum definition `{name}` lacks oneOf")))?;
        let mut variants = Vec::with_capacity(order.len());
        for entry in order {
            let variant_name = entry.as_str().ok_or_else(|| {
                self.error(
                    path,
                    format!("enum `{name}` variant order entry is not a string"),
                )
            })?;
            let variant_path = format!("{path}.oneOf[{variant_name}]");
            ensure_rust_ident("variant", variant_name, &variant_path)?;
            // unit 변형 — {"type":"string","enum":["이름"]}.
            let is_unit = one_of.iter().any(|candidate| {
                candidate.get("type").and_then(Value::as_str) == Some("string")
                    && candidate
                        .get("enum")
                        .and_then(Value::as_array)
                        .and_then(|values| values.first())
                        .and_then(Value::as_str)
                        == Some(variant_name)
            });
            if is_unit {
                variants.push(VariantIr {
                    name: variant_name.to_string(),
                    fields: Vec::new(),
                });
                continue;
            }
            // 데이터 변형 — {"이름": {object}} 단일 프로퍼티 오브젝트(외부 태그).
            // schemars 는 payload 를 properties 아래에 둔다(덤프된 실제 스키마 참고).
            let payload = one_of
                .iter()
                .find_map(|candidate| {
                    candidate
                        .get("properties")
                        .and_then(|properties| properties.get(variant_name))
                })
                .ok_or_else(|| {
                    self.error(
                        variant_path.clone(),
                        format!("enum `{name}` variant `{variant_name}` not found in oneOf"),
                    )
                })?;
            let properties = payload
                .get("properties")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    self.error(
                        variant_path.clone(),
                        format!("enum `{name}` variant `{variant_name}` payload is not an object"),
                    )
                })?;
            let fields = self.collect_fields(properties, defs, &variant_path, name)?;
            variants.push(VariantIr {
                name: variant_name.to_string(),
                fields,
            });
        }
        Ok(DefIr::Enum {
            name: name.to_string(),
            real_ty: format!("crate::{name}"),
            variants,
        })
    }

    /// 스키마 노드 → 미러 타입 표현식. `owner`/`field` 는 합성 튜플 레코드
    /// 명명(`{Owner}{FieldPascal}`)에 쓰인다.
    fn type_expr(
        &mut self,
        schema: &Value,
        defs: &Value,
        path: &str,
        owner: &str,
        field: &str,
    ) -> Result<TypeExpr, RenderError> {
        // nullable 유니언 — schemars 는 Option<T> 를 ["..","null"] 로 쓴다.
        if let Some(types) = schema.get("type").and_then(Value::as_array) {
            let has_null = types.iter().any(|t| t.as_str() == Some("null"));
            let base = types
                .iter()
                .map(|t| t.as_str())
                .find(|t| t.is_some() && *t != Some("null"))
                .flatten()
                .ok_or_else(|| self.error(path, "nullable union without a base type"))?;
            let mut view = schema.clone();
            view["type"] = Value::String(base.to_string());
            let inner = self.type_expr(&view, defs, path, owner, field)?;
            return Ok(if has_null {
                TypeExpr::Option(Box::new(inner))
            } else {
                inner
            });
        }
        if let Some(tag) = schema.get("type").and_then(Value::as_str) {
            match tag {
                "boolean" | "integer" | "number" | "string" => {
                    return scalar_token(schema, path)?
                        .map(TypeExpr::Scalar)
                        .ok_or_else(|| {
                            self.error(path, format!("unsupported scalar tag `{tag}`"))
                        });
                }
                "array" => return self.array_expr(schema, defs, path, owner, field),
                // 동적 맵 — properties 없이 additionalProperties 만 있을 때.
                "object" => {
                    if schema.get("properties").is_some() {
                        return Err(self.error(
                            path,
                            "anonymous nested object field; introduce a named definition ($ref)",
                        ));
                    }
                    let value_schema = schema.get("additionalProperties").ok_or_else(|| {
                        self.error(path, "object without properties or additionalProperties")
                    })?;
                    let inner = self.type_expr(
                        value_schema,
                        defs,
                        &format!("{path}.additionalProperties"),
                        owner,
                        field,
                    )?;
                    return Ok(TypeExpr::Map(Box::new(inner)));
                }
                _ => {}
            }
        }
        // $ref — allOf 래퍼(schemars 가 newtype 필드에 덧씌우는 형태)도 흡수.
        let all_of_ref = schema
            .get("allOf")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(|first| first.get("$ref"))
            .and_then(Value::as_str);
        let target = schema
            .get("$ref")
            .and_then(Value::as_str)
            .or(all_of_ref)
            .ok_or_else(|| {
                self.error(
                    path,
                    "schema node is neither scalar, array, object nor $ref",
                )
            })?;
        let ref_name = target
            .strip_prefix("#/definitions/")
            .ok_or_else(|| self.error(path, format!("$ref outside definitions: {target}")))?;
        let def_schema = defs.get(ref_name).ok_or_else(|| {
            self.error(
                path,
                format!("$ref target not found in definitions: {ref_name}"),
            )
        })?;
        let idx = self.ensure_def(
            ref_name,
            def_schema,
            defs,
            &format!("{path}.$ref({ref_name})"),
        )?;
        Ok(match &self.defs[idx] {
            DefIr::Scalar { .. } => TypeExpr::Newtype(idx),
            _ => TypeExpr::Mirror(idx),
        })
    }

    /// array 스키마 해석 — items 가 배열이면 고정 튜플, uniqueItems 면 셋,
    /// 아니면 Vec.
    fn array_expr(
        &mut self,
        schema: &Value,
        defs: &Value,
        path: &str,
        owner: &str,
        field: &str,
    ) -> Result<TypeExpr, RenderError> {
        let items = schema
            .get("items")
            .ok_or_else(|| self.error(path, "array without items"))?;
        if let Some(element_schemas) = items.as_array() {
            // 고정 길이 튜플 — 합성 Record 미러(`{Owner}{FieldPascal}`, 필드 v0..).
            let struct_name = format!("{owner}{}", pascal_case(field));
            if self.lookup(&struct_name).is_some() {
                return Err(self.error(
                    path,
                    format!("synthetic tuple record name collision: {struct_name}"),
                ));
            }
            let mut element_exprs = Vec::with_capacity(element_schemas.len());
            let mut element_tokens = Vec::with_capacity(element_schemas.len());
            for (i, element) in element_schemas.iter().enumerate() {
                let element_path = format!("{path}.items[{i}]");
                let expr = self.type_expr(element, defs, &element_path, owner, field)?;
                element_tokens.push(self.mirror_token(&expr));
                element_exprs.push(expr);
            }
            let fields = element_exprs
                .into_iter()
                .enumerate()
                .map(|(i, expr)| FieldIr {
                    name: format!("v{i}"),
                    expr,
                })
                .collect();
            let idx = self.defs.len();
            self.defs.push(DefIr::Record {
                name: struct_name.clone(),
                real_ty: format!("({})", element_tokens.join(", ")),
                fields,
            });
            self.index.insert(struct_name, idx);
            return Ok(TypeExpr::Tuple(idx));
        }
        let inner = self.type_expr(items, defs, &format!("{path}.items"), owner, field)?;
        if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
            return Ok(TypeExpr::Set(Box::new(inner)));
        }
        Ok(TypeExpr::Vec(Box::new(inner)))
    }

    fn def_name(&self, idx: usize) -> String {
        match &self.defs[idx] {
            DefIr::Record { name, .. } | DefIr::Enum { name, .. } => name.clone(),
            DefIr::Scalar { name, .. } => name.clone(),
        }
    }

    fn def(&self, idx: usize) -> &DefIr {
        &self.defs[idx]
    }

    /// 미러 타입 토큰 렌더링.
    fn mirror_token(&self, expr: &TypeExpr) -> String {
        match expr {
            TypeExpr::Scalar(scalar) => scalar.mirror.to_string(),
            TypeExpr::Mirror(idx) | TypeExpr::Tuple(idx) => self.def_name(*idx),
            // 핸들 정의는 미러에서 스칼라로 인라인된다.
            TypeExpr::Newtype(idx) => match self.def(*idx) {
                DefIr::Scalar { scalar, .. } => scalar.mirror.to_string(),
                _ => unreachable!("Newtype points at a Scalar def"),
            },
            TypeExpr::Vec(inner) => format!("Vec<{}>", self.mirror_token(inner)),
            TypeExpr::Option(inner) => format!("Option<{}>", self.mirror_token(inner)),
            TypeExpr::Map(inner) => {
                format!(
                    "std::collections::HashMap<String, {}>",
                    self.mirror_token(inner)
                )
            }
            TypeExpr::Set(inner) => format!("Vec<{}>", self.mirror_token(inner)),
        }
    }

    /// 컨테이너 변환에서 map 을 생략할 수 있는가 — 하위 트리 전체가 항등일 때만
    /// (`HashMap<String, Vec<String>>` 처럼 중첩 컨테이너 값이 항등이면
    /// `.map(|(k, v)| (k, v))` 이 되어 clippy::map_identity 에 걸린다).
    /// 스칼라는 미러/실제 토큰까지 같아야 한다(usize↔u64 캐스트는 map 필요).
    fn is_identity(expr: &TypeExpr) -> bool {
        match expr {
            TypeExpr::Scalar(scalar) => scalar.mirror == scalar.real,
            TypeExpr::Vec(inner) | TypeExpr::Option(inner) | TypeExpr::Set(inner) => {
                Self::is_identity(inner)
            }
            TypeExpr::Map(inner) => Self::is_identity(inner),
            TypeExpr::Mirror(_) | TypeExpr::Newtype(_) | TypeExpr::Tuple(_) => false,
        }
    }

    /// 미러 값(`v`) → 실제 타입 값 변환식.
    fn m2r_expr(&self, expr: &TypeExpr, v: &str) -> String {
        match expr {
            TypeExpr::Scalar(scalar) => scalar_cast(v, scalar.real, scalar.mirror),
            TypeExpr::Mirror(_) | TypeExpr::Tuple(_) => format!("{v}.into()"),
            TypeExpr::Newtype(idx) => {
                let real_path = match self.def(*idx) {
                    DefIr::Scalar { real_path, .. } => real_path.clone(),
                    _ => unreachable!("Newtype points at a Scalar def"),
                };
                format!("{real_path}({v})")
            }
            TypeExpr::Vec(inner) => {
                if Self::is_identity(inner) {
                    v.to_string()
                } else {
                    format!(
                        "{v}.into_iter().map(|v| {}).collect()",
                        self.m2r_expr(inner, "v")
                    )
                }
            }
            TypeExpr::Option(inner) => {
                if Self::is_identity(inner) {
                    v.to_string()
                } else {
                    format!("{v}.map(|v| {})", self.m2r_expr(inner, "v"))
                }
            }
            TypeExpr::Map(inner) => {
                // 미러는 HashMap, 실제는 BTreeMap/HashMap(스키마가 구분 못 함) —
                // 주석 없는 collect 로 필드 타입에서 목표 컨테이너를 추론한다.
                if Self::is_identity(inner) {
                    format!("{v}.into_iter().collect()")
                } else {
                    format!(
                        "{v}.into_iter().map(|(k, v)| (k, {})).collect()",
                        self.m2r_expr(inner, "v")
                    )
                }
            }
            TypeExpr::Set(inner) => {
                if Self::is_identity(inner) {
                    format!("{v}.into_iter().collect()")
                } else {
                    format!(
                        "{v}.into_iter().map(|v| {}).collect()",
                        self.m2r_expr(inner, "v")
                    )
                }
            }
        }
    }

    /// 실제 값(`v`) → 미러 타입 값 변환식.
    fn r2m_expr(&self, expr: &TypeExpr, v: &str) -> String {
        match expr {
            TypeExpr::Scalar(scalar) => scalar_cast(v, scalar.mirror, scalar.real),
            TypeExpr::Mirror(_) | TypeExpr::Tuple(_) => format!("{v}.into()"),
            TypeExpr::Newtype(_) => format!("{v}.0"),
            TypeExpr::Vec(inner) => {
                if Self::is_identity(inner) {
                    v.to_string()
                } else {
                    format!(
                        "{v}.into_iter().map(|v| {}).collect()",
                        self.r2m_expr(inner, "v")
                    )
                }
            }
            TypeExpr::Option(inner) => {
                if Self::is_identity(inner) {
                    v.to_string()
                } else {
                    format!("{v}.map(|v| {})", self.r2m_expr(inner, "v"))
                }
            }
            TypeExpr::Map(inner) => {
                if Self::is_identity(inner) {
                    format!("{v}.into_iter().collect()")
                } else {
                    format!(
                        "{v}.into_iter().map(|(k, v)| (k, {})).collect()",
                        self.r2m_expr(inner, "v")
                    )
                }
            }
            TypeExpr::Set(inner) => {
                if Self::is_identity(inner) {
                    format!("{v}.into_iter().collect()")
                } else {
                    format!(
                        "{v}.into_iter().map(|v| {}).collect()",
                        self.r2m_expr(inner, "v")
                    )
                }
            }
        }
    }

    /// 최종 소스 렌더링 — `pub mod uniffi_api` + 크레이트 루트 scaffolding.
    fn emit(&self) -> String {
        let mut out = String::with_capacity(16 * 1024);
        out.push_str("// 이 파일은 rustra 코드젠(uniffi_render)이 생성한 UniFFI 미러 계층이다.\n");
        out.push_str("// 손으로 수정하지 마세요 — 재생성: RUSTRA_UNIFFI_OUT=src cargo run -p \\\n");
        out.push_str("//   rustra-calculator-example --bin generate\n");
        out.push_str("// 원천: generate_typescript() 의 schema_json — 커맨드/정의 선언 순서가\n");
        out.push_str("// 곧 미러 필드 순서다(postcard 와이어와 동일 원천).\n\n");
        out.push_str("pub mod uniffi_api {\n");
        self.emit_error_mirror(&mut out);
        self.emit_defs(&mut out);
        self.emit_conversions(&mut out);
        self.emit_package_access(&mut out);
        self.emit_command_wrappers(&mut out);
        self.emit_generic_surface(&mut out);
        out.push_str("}\n\n");
        // scaffolding 은 크레이트 루트에 둔다 — 인라인 모듈 안에 두면 export
        // 매크로가 crate::UniFfiTag 를 찾지 못한다(스파이크에서 검증).
        out.push_str("uniffi::setup_scaffolding!();\n");
        out
    }

    fn emit_error_mirror(&self, out: &mut String) {
        out.push_str("    // ── 에러 미러 — rustra RustraError 의 3-필드 실패 모델 ──\n");
        out.push_str("    // 필드명 주의: `message` 는 Kotlin 생성 바인딩에서 Throwable.message\n");
        out.push_str("    // 오버라이드와 충돌한다(주 생성자 프로퍼티 + body get() 이중 선언) —\n");
        out.push_str(
            "    // uniffi 0.32.1 Kotlin 생성기의 알려진 날카로운 모서리. `detail` 로 회피.\n",
        );
        out.push_str("    #[derive(Debug, uniffi::Error)]\n");
        out.push_str("    pub enum RustraCommandFailure {\n");
        out.push_str("        Failure {\n");
        out.push_str("            code: String,\n");
        out.push_str("            detail: String,\n");
        out.push_str("            retryable: bool,\n");
        out.push_str("        },\n");
        out.push_str("    }\n\n");
        out.push_str("    impl std::fmt::Display for RustraCommandFailure {\n");
        out.push_str(
            "        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n",
        );
        out.push_str("            match self {\n");
        out.push_str("                RustraCommandFailure::Failure { code, detail, .. } => {\n");
        out.push_str("                    write!(f, \"{code}: {detail}\")\n");
        out.push_str("                }\n");
        out.push_str("            }\n");
        out.push_str("        }\n");
        out.push_str("    }\n\n");
        out.push_str("    impl From<rustra::RustraError> for RustraCommandFailure {\n");
        out.push_str("        fn from(error: rustra::RustraError) -> Self {\n");
        out.push_str("            Self::Failure {\n");
        out.push_str("                code: error.code().to_string(),\n");
        out.push_str("                detail: error.message().to_string(),\n");
        out.push_str("                retryable: error.is_retryable(),\n");
        out.push_str("            }\n");
        out.push_str("        }\n");
        out.push_str("    }\n\n");
    }

    fn emit_defs(&self, out: &mut String) {
        out.push_str("    // ── 미러 타입 — 정의/커맨드 입출력 순서(스키마 최초 등장 순) ──\n");
        for def in &self.defs {
            match def {
                DefIr::Record {
                    name,
                    real_ty,
                    fields,
                } => {
                    out.push_str(&format!("    /// `{name}` 미러 — 실제 타입 `{real_ty}`.\n"));
                    out.push_str("    #[derive(Debug, uniffi::Record)]\n");
                    out.push_str(&format!("    pub struct {name} {{\n"));
                    for field in fields {
                        out.push_str(&format!(
                            "        pub {}: {},\n",
                            field.name,
                            self.mirror_token(&field.expr)
                        ));
                    }
                    out.push_str("    }\n\n");
                }
                DefIr::Enum {
                    name,
                    real_ty,
                    variants,
                } => {
                    out.push_str(&format!(
                        "    /// `{name}` 미러 — 실제 타입 `{real_ty}`(외부 태그 oneOf 스키마).\n"
                    ));
                    out.push_str("    #[derive(Debug, uniffi::Enum)]\n");
                    out.push_str(&format!("    pub enum {name} {{\n"));
                    for variant in variants {
                        if variant.fields.is_empty() {
                            out.push_str(&format!("        {},\n", variant.name));
                        } else {
                            out.push_str(&format!("        {} {{\n", variant.name));
                            for field in &variant.fields {
                                out.push_str(&format!(
                                    "            {}: {},\n",
                                    field.name,
                                    self.mirror_token(&field.expr)
                                ));
                            }
                            out.push_str("        },\n");
                        }
                    }
                    out.push_str("    }\n\n");
                }
                // 스칼라 핸들 정의는 미러 타입을 만들지 않는다(필드에서 인라인).
                DefIr::Scalar { .. } => {}
            }
        }
    }

    fn emit_conversions(&self, out: &mut String) {
        out.push_str("    // ── 미러 ↔ 실제 양방향 변환 ──\n");
        for def in &self.defs {
            match def {
                DefIr::Record {
                    name,
                    real_ty,
                    fields,
                } => {
                    let is_tuple = real_ty.starts_with('(');
                    // 미러 → 실제.
                    out.push_str(&format!("    impl From<{name}> for {real_ty} {{\n"));
                    out.push_str(&format!("        fn from(input: {name}) -> Self {{\n"));
                    if is_tuple {
                        let element_exprs = fields
                            .iter()
                            .map(|field| {
                                self.m2r_expr(&field.expr, &format!("input.{}", field.name))
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        out.push_str(&format!("            ({element_exprs})\n"));
                    } else {
                        out.push_str("            Self {\n");
                        for field in fields {
                            out.push_str(&format!(
                                "                {}: {},\n",
                                field.name,
                                self.m2r_expr(&field.expr, &format!("input.{}", field.name))
                            ));
                        }
                        out.push_str("            }\n");
                    }
                    out.push_str("        }\n");
                    out.push_str("    }\n\n");
                    // 실제 → 미러.
                    out.push_str(&format!("    impl From<{real_ty}> for {name} {{\n"));
                    out.push_str(&format!("        fn from(input: {real_ty}) -> Self {{\n"));
                    out.push_str("            Self {\n");
                    for (i, field) in fields.iter().enumerate() {
                        let value = if is_tuple {
                            format!("input.{i}")
                        } else {
                            format!("input.{}", field.name)
                        };
                        out.push_str(&format!(
                            "                {}: {},\n",
                            field.name,
                            self.r2m_expr(&field.expr, &value)
                        ));
                    }
                    out.push_str("            }\n");
                    out.push_str("        }\n");
                    out.push_str("    }\n\n");
                }
                DefIr::Enum {
                    name,
                    real_ty,
                    variants,
                } => {
                    // 미러 → 실제. 패턴은 반드시 경로 한정 — struct 변형 패턴
                    // (`Set { value }`)은 스크루티니 타입 추론이 되지 않는다.
                    out.push_str(&format!("    impl From<{name}> for {real_ty} {{\n"));
                    out.push_str(&format!("        fn from(input: {name}) -> Self {{\n"));
                    out.push_str("            match input {\n");
                    for variant in variants {
                        let pattern = variant_pattern(name, &variant.name, &variant.fields);
                        let construction = variant_fields_construct(
                            &format!("{real_ty}::{}", variant.name),
                            &variant.fields,
                            &|expr, bound| self.m2r_expr(expr, bound),
                        );
                        out.push_str(&format!("                {pattern} => {construction},\n"));
                    }
                    out.push_str("            }\n");
                    out.push_str("        }\n");
                    out.push_str("    }\n\n");
                    // 실제 → 미러.
                    out.push_str(&format!("    impl From<{real_ty}> for {name} {{\n"));
                    out.push_str(&format!("        fn from(input: {real_ty}) -> Self {{\n"));
                    out.push_str("            match input {\n");
                    for variant in variants {
                        let pattern = variant_pattern(real_ty, &variant.name, &variant.fields);
                        let construction = variant_fields_construct(
                            &format!("{name}::{}", variant.name),
                            &variant.fields,
                            &|expr, bound| self.r2m_expr(expr, bound),
                        );
                        out.push_str(&format!("                {pattern} => {construction},\n"));
                    }
                    out.push_str("            }\n");
                    out.push_str("        }\n");
                    out.push_str("    }\n\n");
                }
                DefIr::Scalar { .. } => {}
            }
        }
    }

    fn emit_package_access(&self, out: &mut String) {
        out.push_str("    // ── 패키지 접근 — calculator_package() 가 이미 OnceLock 싱글턴 ──\n");
        out.push_str("    fn package() -> rustra::Package {\n");
        out.push_str("        crate::calculator_package()\n");
        out.push_str("    }\n\n");
    }

    fn emit_command_wrappers(&self, out: &mut String) {
        out.push_str("    // ── 커맨드별 타입 래퍼 — 스키마 등록 순서 ──\n");
        for command in &self.commands {
            let snake = camel_to_snake(&command.name);
            match &command.input {
                Some(input) => {
                    out.push_str(&format!(
                        "    /// `{name}` — `crate::{snake}` 커맨드의 UniFFI 타입 래퍼.\n",
                        name = command.name,
                    ));
                    out.push_str("    #[uniffi::export]\n");
                    out.push_str("    #[allow(non_snake_case)]\n");
                    out.push_str(&format!(
                        "    pub fn {name}(input: {input}) -> Result<{output}, RustraCommandFailure> {{\n",
                        name = command.name,
                        output = command.output,
                    ));
                    // I/O 타입 파라미터를 명시한다 — `input.into()` 의 I 는
                    // 출력 바인딩만으로는 추론되지 않는다.
                    out.push_str(&format!(
                        "        let out: crate::{output} = package()\n",
                        output = command.output,
                    ));
                    out.push_str(&format!(
                        "            .invoke_typed::<crate::{input}, crate::{output}>(\"{name}\", &input.into())?;\n",
                        input = input,
                        output = command.output,
                        name = command.name,
                    ));
                }
                None => {
                    out.push_str(&format!(
                        "    /// `{name}` — `crate::{snake}`(unit 입력)의 UniFFI 타입 래퍼.\n",
                        name = command.name,
                    ));
                    out.push_str("    #[uniffi::export]\n");
                    out.push_str("    #[allow(non_snake_case)]\n");
                    out.push_str(&format!(
                        "    pub fn {name}() -> Result<{output}, RustraCommandFailure> {{\n",
                        name = command.name,
                        output = command.output,
                    ));
                    out.push_str(&format!(
                        "        let out: crate::{output} =\n            package().invoke_typed::<(), crate::{output}>(\"{name}\", &())?;\n",
                        output = command.output,
                        name = command.name,
                    ));
                }
            }
            out.push_str("        Ok(out.into())\n");
            out.push_str("    }\n\n");
        }
    }

    fn emit_generic_surface(&self, out: &mut String) {
        out.push_str("    // ── 제네릭 표면 — JSON 경로/스키마/계약 해시 ──\n");
        out.push_str("    /// 이름 기반 JSON 호출 — `Package::invoke_json` 의 문자열 경계 래퍼.\n");
        out.push_str("    #[uniffi::export]\n");
        out.push_str("    #[allow(non_snake_case)]\n");
        out.push_str(
            "    pub fn invokeJson(command: String, args_json: String) -> Result<String, RustraCommandFailure> {\n",
        );
        out.push_str("        let args: serde_json::Value = if args_json.is_empty() {\n");
        out.push_str("            serde_json::Value::Null\n");
        out.push_str("        } else {\n");
        out.push_str("            serde_json::from_str(&args_json).map_err(|error| {\n");
        out.push_str("                RustraCommandFailure::Failure {\n");
        out.push_str("                    code: \"uniffi.invalid_json\".to_string(),\n");
        out.push_str("                    detail: error.to_string(),\n");
        out.push_str("                    retryable: false,\n");
        out.push_str("                }\n");
        out.push_str("            })?\n");
        out.push_str("        };\n");
        out.push_str("        package()\n");
        out.push_str("            .invoke_json(&command, args)\n");
        out.push_str("            .map(|value| value.to_string())\n");
        out.push_str("            .map_err(RustraCommandFailure::from)\n");
        out.push_str("    }\n\n");
        out.push_str("    /// 라이브 스키마 JSON — `Package::live_schema`.\n");
        out.push_str("    #[uniffi::export]\n");
        out.push_str("    #[allow(non_snake_case)]\n");
        out.push_str("    pub fn getSchema() -> String {\n");
        out.push_str("        package().live_schema().to_string()\n");
        out.push_str("    }\n\n");
        out.push_str("    /// 계약 해시 — FFI `rustra_ffi_contract_hash` 와 동일 단일 소스.\n");
        out.push_str("    /// 같은 dylib 안의 심볼을 직접 호출해 로직 복제를 피한다.\n");
        out.push_str("    #[uniffi::export]\n");
        out.push_str("    #[allow(non_snake_case)]\n");
        out.push_str("    pub fn contractHash() -> Result<String, RustraCommandFailure> {\n");
        out.push_str("        // FFI 전역 등록 보장(생성자 미탑재 호스트 대비, idempotent).\n");
        out.push_str("        let _ = package();\n");
        out.push_str("        let mut len: usize = 0;\n");
        out.push_str("        let ptr = unsafe { rustra_ffi_contract_hash(&mut len) };\n");
        out.push_str("        if ptr.is_null() {\n");
        out.push_str("            return Err(RustraCommandFailure::Failure {\n");
        out.push_str("                code: \"uniffi.contract_hash\".to_string(),\n");
        out.push_str("                detail: \"contract hash unavailable\".to_string(),\n");
        out.push_str("                retryable: false,\n");
        out.push_str("            });\n");
        out.push_str("        }\n");
        out.push_str(
            "        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();\n",
        );
        out.push_str("        unsafe { rustra_ffi_free(ptr, len) };\n");
        out.push_str("        String::from_utf8(bytes).map_err(|error| {\n");
        out.push_str("            RustraCommandFailure::Failure {\n");
        out.push_str("                code: \"uniffi.contract_hash\".to_string(),\n");
        out.push_str("                detail: error.to_string(),\n");
        out.push_str("                retryable: false,\n");
        out.push_str("            }\n");
        out.push_str("        })\n");
        out.push_str("    }\n\n");
        out.push_str("    // `rustra_ffi_*` 는 같은 최종 바이너리(cdylib/rlib)에 링크되는 코어\n");
        out.push_str("    // FFI 심볼이다 — 계약 해시의 단일 소스를 그대로 재사용한다.\n");
        out.push_str("    unsafe extern \"C\" {\n");
        out.push_str("        fn rustra_ffi_contract_hash(out_len: *mut usize) -> *mut u8;\n");
        out.push_str("        fn rustra_ffi_free(ptr: *mut u8, len: usize);\n");
        out.push_str("    }\n");
    }
}

/// enum 변형의 match 패턴 — `OpKind::Clear` / `OpKind::Set { value }`.
/// 경로를 반드시 한정한다: struct 변형 패턴은 스크루티니 타입으로 변형이
/// 결정되지 않아(스코프의 struct 로 해석 시도) 컴파일 오류가 난다.
fn variant_pattern(enum_path: &str, name: &str, fields: &[FieldIr]) -> String {
    if fields.is_empty() {
        format!("{enum_path}::{name}")
    } else {
        let bindings = fields
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("{enum_path}::{name} {{ {bindings} }}")
    }
}

/// enum 변형 생성자 — 각 필드를 `convert(expr, 바인딩명)` 으로 변환해 조립.
/// 변환이 항등(스칼라)이면 필드 축약 문법으로 정리한다.
fn variant_fields_construct(
    path: &str,
    fields: &[FieldIr],
    convert: &dyn Fn(&TypeExpr, &str) -> String,
) -> String {
    if fields.is_empty() {
        return path.to_string();
    }
    let rendered = fields
        .iter()
        .map(|field| {
            let converted = convert(&field.expr, &field.name);
            if converted == field.name {
                // 축약 — `value` (`value: value` 대신).
                field.name.clone()
            } else {
                format!("{}: {}", field.name, converted)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{path} {{ {rendered} }}")
}

/// 스키마 노드의 스칼라 토큰 판정 — 스칼라가 아니면 None, 미지원 포맷은 Err.
/// 반환은 (미러 토큰, 실제 토큰) 쌍이다.
fn scalar_token(schema: &Value, path: &str) -> Result<Option<ScalarType>, RenderError> {
    let same = |token: &'static str| ScalarType {
        mirror: token,
        real: token,
    };
    let format = schema.get("format").and_then(Value::as_str);
    let token = match schema.get("type").and_then(Value::as_str) {
        Some("boolean") => same("bool"),
        Some("string") => same("String"),
        Some("integer") => match format {
            Some("int8") => same("i8"),
            Some("int16") => same("i16"),
            Some("int32") => same("i32"),
            Some("int64") => same("i64"),
            Some("int") => ScalarType {
                mirror: "i64",
                real: "isize",
            },
            Some("uint8") => same("u8"),
            Some("uint16") => same("u16"),
            Some("uint32") => same("u32"),
            Some("uint64") => same("u64"),
            // usize — schemars 의 포맷은 "uint". uniffi 미지원이라 u64 미러.
            Some("uint") => ScalarType {
                mirror: "u64",
                real: "usize",
            },
            other => {
                return Err(RenderError {
                    path: path.to_string(),
                    reason: format!("unsupported integer format {other:?}"),
                });
            }
        },
        Some("number") => match format {
            Some("float") => same("f32"),
            Some("double") => same("f64"),
            other => {
                return Err(RenderError {
                    path: path.to_string(),
                    reason: format!("unsupported number format {other:?}"),
                });
            }
        },
        // 스칼라 아님(배열/오브젝트/unknown) — 호출자가 분기한다.
        _ => return Ok(None),
    };
    Ok(Some(token))
}

/// 스칼라 변환식 — 미러/실제 토큰이 다르면(usize↔u64) 경계에서 cast 한다.
fn scalar_cast(v: &str, target: &str, source: &str) -> String {
    if target == source {
        v.to_string()
    } else {
        format!("{v} as {target}")
    }
}

/// camelCase → snake_case. 스키마 프로퍼티(camelCase)를 실제 Rust 필드명으로
/// 되돌리는 규칙 — serde `rename_all = "camelCase"` 의 역방향.
fn camel_to_snake(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for (i, ch) in input.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// 첫 글자만 대문자로 — 합성 튜플 레코드 명명용(`pair` → `Pair`).
fn pascal_case(input: &str) -> String {
    let mut chars = input.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 최소 스키마 문서 조립 — 테스트용 헬퍼.
    fn doc(commands: serde_json::Value) -> String {
        serde_json::json!({ "packageId": "test", "commands": commands }).to_string()
    }

    fn object_command(name: &str, input: &str, output: &str) -> serde_json::Value {
        // 실제 스키마와 같이 inputType/outputType 은 PascalCase 타입명이다.
        let pascal = pascal_case(name);
        serde_json::json!({
            "name": name,
            "commandId": 1,
            "inputType": format!("{pascal}Input"),
            "outputType": format!("{pascal}Output"),
            "inputSchema": serde_json::from_str::<Value>(input).unwrap(),
            "outputSchema": serde_json::from_str::<Value>(output).unwrap(),
        })
    }

    #[test]
    fn renders_scalar_record_and_wrapper() {
        let source = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "addNumbers",
            r#"{"title":"AddNumbersInput","type":"object","required":["a","b"],
                "properties":{"a":{"type":"integer","format":"int64"},"b":{"type":"integer","format":"int64"}}}"#,
            r#"{"title":"AddNumbersOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"integer","format":"int64"}}}"#
        )])))
        .unwrap();
        // 미러는 인라인 모듈 안에 원래 이름으로, scaffolding 은 크레이트 루트에.
        assert!(source.contains("pub mod uniffi_api {"));
        assert!(source.contains("#[derive(Debug, uniffi::Record)]"));
        assert!(source.contains("pub struct AddNumbersInput {"));
        assert!(source.contains("pub a: i64,"));
        assert!(source.contains("pub b: i64,"));
        assert!(source.contains("uniffi::setup_scaffolding!();"));
        // 커맨드 래퍼 — camelCase export + invoke_typed 위임.
        let lines = source.split('\n').collect::<Vec<_>>();
        let fn_idx = lines
            .iter()
            .position(|line| line.contains("pub fn addNumbers"))
            .unwrap();
        let window = lines[fn_idx - 3..fn_idx + 4].join("\n");
        assert!(window.contains("#[uniffi::export]"), "wrapper: {window}");
        assert!(window.contains("#[allow(non_snake_case)]"));
        assert!(
            window.contains("Result<AddNumbersOutput, RustraCommandFailure>"),
            "wrapper: {window}"
        );
        assert!(window.contains("invoke_typed::<crate::AddNumbersInput, crate::AddNumbersOutput>(\"addNumbers\", &input.into())"));
    }

    #[test]
    fn field_order_follows_schema_declaration_order() {
        // clamp 스키마의 프로퍼티 순서(max, min, value)가 미러 필드 순서로.
        let source = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "clamp",
            r#"{"title":"ClampInput","type":"object","required":["max","min","value"],
                "properties":{"max":{"type":"number","format":"double"},
                              "min":{"type":"number","format":"double"},
                              "value":{"type":"number","format":"double"}}}"#,
            r#"{"title":"ClampOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"number","format":"double"}}}"#
        )])))
        .unwrap();
        let input_struct = &source[source.find("pub struct ClampInput").unwrap()..];
        let max = input_struct.find("pub max: f64,").unwrap();
        let min = input_struct.find("pub min: f64,").unwrap();
        let value = input_struct.find("pub value: f64,").unwrap();
        assert!(
            max < min && min < value,
            "declaration order kept: {input_struct}"
        );
    }

    #[test]
    fn renders_enum_with_data_variants() {
        let mut command = object_command(
            "kindEcho",
            r##"{"title":"KindEchoInput","type":"object","required":["kind"],
                "properties":{"kind":{"$ref":"#/definitions/OpKind"}}}"##,
            r##"{"title":"KindEchoOutput","type":"object","required":["echoed"],
                "properties":{"echoed":{"$ref":"#/definitions/OpKind"}}}"##,
        );
        command["definitions"] = serde_json::json!({
            "OpKind": {
                "oneOf": [
                    {"type": "string", "enum": ["Clear"]},
                    {"type": "object", "required": ["Set"], "additionalProperties": false,
                     "properties": {"Set": {"type": "object", "required": ["value"],
                         "properties": {"value": {"type": "integer", "format": "int64"}}}}}
                ],
                "x-rustra-variant-order": ["Clear", "Set"]
            }
        });
        let source = render_uniffi_generated(&doc(serde_json::json!([command]))).unwrap();
        assert!(source.contains("#[derive(Debug, uniffi::Enum)]"));
        let enum_body = &source[source.find("pub enum OpKind").unwrap()..];
        assert!(enum_body.contains("Clear,"));
        assert!(enum_body.contains("Set {"));
        assert!(enum_body.contains("value: i64,"));
        // 양방향 변환 — 변형 순서 보존 match, 패턴은 경로 한정.
        assert!(source.contains("OpKind::Clear => crate::OpKind::Clear,"));
        assert!(source.contains("OpKind::Set { value } => crate::OpKind::Set { value }"));
        assert!(source.contains("crate::OpKind::Clear => OpKind::Clear,"));
        assert!(source.contains("crate::OpKind::Set { value } => OpKind::Set { value }"));
    }

    #[test]
    fn renders_option_map_set_tuple_shapes() {
        let mut command = object_command(
            "kitchen",
            r#"{"title":"KitchenInput","type":"object","required":["samples","groups","ids","pair"],
                "properties":{"samples":{"type":"array","items":{"type":"integer","format":"uint64"}},
                              "offset":{"type":["integer","null"],"format":"int64"},
                              "groups":{"type":"object","additionalProperties":{"type":"array",
                                  "items":{"type":"string"}}},
                              "ids":{"type":"array","uniqueItems":true,
                                  "items":{"type":"integer","format":"int64"}},
                              "pair":{"type":"array","minItems":2,"maxItems":2,
                                  "items":[{"type":"string"},{"type":"integer","format":"int64"}]}}}"#,
            r#"{"title":"KitchenOutput","type":"object","required":["ok"],
                "properties":{"ok":{"type":"boolean"}}}"#,
        );
        command["definitions"] = serde_json::json!({});
        let source = render_uniffi_generated(&doc(serde_json::json!([command]))).unwrap();
        assert!(source.contains("pub samples: Vec<u64>,"));
        assert!(source.contains("pub offset: Option<i64>,"));
        assert!(source.contains("pub groups: std::collections::HashMap<String, Vec<String>>,"));
        // 셋은 미러에서 Vec — 변환에서 실제 셋 컨테이너로 추론 수집된다.
        assert!(source.contains("pub ids: Vec<i64>,"));
        assert!(source.contains("ids: input.ids.into_iter().collect()"));
        // 튜플은 합성 Record(v0/v1) — 실제 Rust 튜플과 상호 변환.
        assert!(source.contains("pub struct KitchenInputPair {"));
        assert!(source.contains("pub pair: KitchenInputPair,"));
        assert!(source.contains("impl From<KitchenInputPair> for (String, i64)"));
        assert!(source.contains("(input.v0, input.v1)"));
        assert!(source.contains("impl From<(String, i64)> for KitchenInputPair"));
        assert!(source.contains("v0: input.0,"));
        assert!(source.contains("v1: input.1,"));
    }

    #[test]
    fn renders_newtype_handle_as_scalar_with_wrap() {
        let mut command = object_command(
            "channelDemo",
            r##"{"title":"ChannelDemoInput","type":"object","required":["channel"],
                "properties":{"channel":{"allOf":[{"$ref":"#/definitions/ChannelHandle"}]}}}"##,
            r#"{"title":"ChannelDemoOutput","type":"object","required":["sent"],
                "properties":{"sent":{"type":"integer","format":"int32"}}}"#,
        );
        command["definitions"] = serde_json::json!({
            "ChannelHandle": {"type": "integer", "format": "uint32", "minimum": 0.0}
        });
        let source = render_uniffi_generated(&doc(serde_json::json!([command]))).unwrap();
        // 핸들 정의는 미러 타입 없이 u32 로 인라인된다.
        assert!(source.contains("pub channel: u32,"));
        assert!(!source.contains("pub struct ChannelHandle {"));
        // 변환은 표의 newtype 경로로 래핑/언래핑.
        assert!(source.contains("channel: rustra::channels::ChannelHandle(input.channel),"));
        assert!(source.contains("channel: input.channel.0,"));
    }

    #[test]
    fn unit_input_command_takes_no_parameter() {
        let source = render_uniffi_generated(&doc(serde_json::json!([{
            "name": "deviceDemo",
            "commandId": 32,
            "inputType": "()",
            "outputType": "DeviceDemoOutput",
            "inputSchema": {"title": "Null", "type": "null"},
            "outputSchema": {"title": "DeviceDemoOutput", "type": "object",
                "required": ["os"], "properties": {"os": {"type": "string"}}}
        }])))
        .unwrap();
        assert!(
            source.contains(
                "pub fn deviceDemo() -> Result<DeviceDemoOutput, RustraCommandFailure> {"
            )
        );
        assert!(
            source.contains("invoke_typed::<(), crate::DeviceDemoOutput>(\"deviceDemo\", &())")
        );
    }

    #[test]
    fn fail_closed_on_unsupported_integer_format() {
        let error = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "big",
            r#"{"title":"BigInput","type":"object","required":["n"],
                "properties":{"n":{"type":"integer","format":"int128"}}}"#,
            r#"{"title":"BigOutput","type":"object","required":["ok"],
                "properties":{"ok":{"type":"boolean"}}}"#
        )])))
        .unwrap_err();
        assert!(error.reason.contains("int128"), "{error}");
        assert!(error.path.contains("properties.n"), "{error}");
    }

    #[test]
    fn fail_closed_on_anonymous_nested_object() {
        let error = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "nested",
            r#"{"title":"NestedInput","type":"object","required":["inner"],
                "properties":{"inner":{"type":"object","required":["x"],
                    "properties":{"x":{"type":"integer","format":"int64"}}}}}"#,
            r#"{"title":"NestedOutput","type":"object","required":["ok"],
                "properties":{"ok":{"type":"boolean"}}}"#
        )])))
        .unwrap_err();
        assert!(error.reason.contains("anonymous nested object"), "{error}");
    }

    #[test]
    fn fail_closed_on_unmapped_scalar_definition() {
        let mut command = object_command(
            "token",
            r##"{"title":"TokenInput","type":"object","required":["t"],
                "properties":{"t":{"$ref":"#/definitions/Token"}}}"##,
            r#"{"title":"TokenOutput","type":"object","required":["ok"],
                "properties":{"ok":{"type":"boolean"}}}"#,
        );
        command["definitions"] = serde_json::json!({
            "Token": {"type": "integer", "format": "uint64", "minimum": 0.0}
        });
        let error = render_uniffi_generated(&doc(serde_json::json!([command]))).unwrap_err();
        assert!(error.reason.contains("no real-type mapping"), "{error}");
        assert!(error.reason.contains("Token"), "{error}");
    }

    #[test]
    fn generic_surface_and_error_mirror_present() {
        let source = render_uniffi_generated(&doc(serde_json::json!([]))).unwrap();
        assert!(source.contains("pub fn invokeJson(command: String, args_json: String)"));
        assert!(source.contains("pub fn getSchema() -> String"));
        assert!(source.contains("pub fn contractHash() -> Result<String, RustraCommandFailure>"));
        assert!(source.contains("fn rustra_ffi_contract_hash(out_len: *mut usize) -> *mut u8;"));
        assert!(source.contains("#[derive(Debug, uniffi::Error)]"));
        assert!(source.contains("impl From<rustra::RustraError> for RustraCommandFailure"));
        assert!(source.contains("impl std::fmt::Display for RustraCommandFailure"));
        assert!(source.contains("fn package() -> rustra::Package"));
    }

    #[test]
    fn camel_to_snake_round_trips_serde_rename_all() {
        assert_eq!(camel_to_snake("stepDelayMs"), "step_delay_ms");
        assert_eq!(camel_to_snake("a"), "a");
        assert_eq!(camel_to_snake("droppedSends"), "dropped_sends");
        assert_eq!(pascal_case("pair"), "Pair");
    }

    // ── 식별자 검증 — rustc 가 아니라 렌더 시점, 스키마 경로와 함께 실패 ──────

    #[test]
    fn keyword_field_name_fails_with_schema_path() {
        let error = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "kwField",
            r#"{"title":"KwFieldInput","type":"object","required":["type"],
                "properties":{"type":{"type":"string"}}}"#,
            r#"{"title":"KwFieldOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"string"}}}"#
        )])))
        .unwrap_err();
        assert!(
            error
                .path
                .ends_with("commands[kwField].inputSchema.properties.type"),
            "path: {}",
            error.path
        );
        assert!(error.reason.contains("Rust keyword"), "{error}");
        assert!(error.reason.contains("`type`"), "{error}");
    }

    #[test]
    fn non_identifier_names_fail_at_render() {
        let bad_digit = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "digitStart",
            r#"{"title":"DigitStartInput","type":"object","required":["2fast"],
                "properties":{"2fast":{"type":"string"}}}"#,
            r#"{"title":"DigitStartOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"string"}}}"#
        )])))
        .unwrap_err();
        assert!(
            bad_digit.reason.contains("starts with a digit"),
            "{bad_digit}"
        );

        let bad_dash = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "dashField",
            r#"{"title":"DashFieldInput","type":"object","required":["foo-bar"],
                "properties":{"foo-bar":{"type":"string"}}}"#,
            r#"{"title":"DashFieldOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"string"}}}"#
        )])))
        .unwrap_err();
        assert!(
            bad_dash.reason.contains("not a valid Rust identifier"),
            "{bad_dash}"
        );
        assert!(
            bad_dash
                .path
                .ends_with("commands[dashField].inputSchema.properties.foo-bar"),
            "path: {}",
            bad_dash.path
        );
    }

    #[test]
    fn keyword_type_name_fails() {
        // inputType/title 이 키워드면 미러 선언도 real_ty 경로도 성립하지 않는다.
        let command = serde_json::json!([{
            "name": "typeCmd",
            "commandId": 1,
            "inputType": "type",
            "outputType": "TypeCmdOutput",
            "inputSchema": {"title": "type", "type": "object", "required": ["value"],
                "properties": {"value": {"type": "string"}}},
            "outputSchema": {"title": "TypeCmdOutput", "type": "object", "required": ["value"],
                "properties": {"value": {"type": "string"}}}
        }]);
        let error = render_uniffi_generated(&doc(command)).unwrap_err();
        assert!(
            error.path.ends_with("commands[typeCmd].inputSchema"),
            "path: {}",
            error.path
        );
        assert!(error.reason.contains("Rust keyword"), "{error}");
    }

    #[test]
    fn keyword_command_name_fails() {
        let command = serde_json::json!([{
            "name": "match",
            "commandId": 1,
            "inputType": "MatchInput",
            "outputType": "MatchOutput",
            "inputSchema": {"title": "MatchInput", "type": "object", "required": ["value"],
                "properties": {"value": {"type": "string"}}},
            "outputSchema": {"title": "MatchOutput", "type": "object", "required": ["value"],
                "properties": {"value": {"type": "string"}}}
        }]);
        let error = render_uniffi_generated(&doc(command)).unwrap_err();
        assert!(
            error.path.ends_with("commands[match].name"),
            "path: {}",
            error.path
        );
        assert!(error.reason.contains("Rust keyword"), "{error}");
    }

    #[test]
    fn keyword_variant_name_fails() {
        let mut command = object_command(
            "kindEcho",
            r##"{"title":"KindEchoInput","type":"object","required":["kind"],
                "properties":{"kind":{"$ref":"#/definitions/OpKind"}}}"##,
            r##"{"title":"KindEchoOutput","type":"object","required":["echoed"],
                "properties":{"echoed":{"$ref":"#/definitions/OpKind"}}}"##,
        );
        command["definitions"] = serde_json::json!({
            "OpKind": {
                "oneOf": [
                    {"type": "string", "enum": ["move"]}
                ],
                "x-rustra-variant-order": ["move"]
            }
        });
        let error = render_uniffi_generated(&doc(serde_json::json!([command]))).unwrap_err();
        assert!(error.path.ends_with("oneOf[move]"), "path: {}", error.path);
        assert!(error.reason.contains("Rust keyword"), "{error}");
    }

    #[test]
    fn duplicate_snake_field_mapping_fails() {
        // `fooBar` 와 `foo_bar` 는 snake 변환 후 같은 필드로 충돌한다.
        let error = render_uniffi_generated(&doc(serde_json::json!([object_command(
            "dupFields",
            r#"{"title":"DupFieldsInput","type":"object","required":["fooBar","foo_bar"],
                "properties":{"fooBar":{"type":"string"},
                              "foo_bar":{"type":"string"}}}"#,
            r#"{"title":"DupFieldsOutput","type":"object","required":["value"],
                "properties":{"value":{"type":"string"}}}"#
        )])))
        .unwrap_err();
        assert!(error.reason.contains("already declared"), "{error}");
        assert!(
            error
                .path
                .ends_with("commands[dupFields].inputSchema.properties.foo_bar"),
            "path: {}",
            error.path
        );
    }
}
