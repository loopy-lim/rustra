//! Complex codec 스키마 사전컴파일 IR.
//!
//! `serde_json::Value` 스키마를 코덱 생성 시점에 **한 번** 순회해 닫힌 노드
//! 트리로 만든다. 이후 encode/decode 는 `&Value` 스키마를 호출마다 재해석하지
//! 않고 IR 만 순회한다 — 매 호출의 `resolved_schema` 클론, `option_inner`
//! 클론, `variants` 클론+정렬이 모두 빌드 시점 1회로 이동한다.
//!
//! 와이어 불변식: IR 순회는 기존 런타임 해석과 바이트 단위로 동일해야 한다
//! (게이트 — complex round-trip 테스트 + PINNED wire fixture 전수). 원본이
//! 매 호출 raw 스키마 모양을 보고 내리는 결정들을 빌드 시점에 스냅샷한다:
//!
//! - `$ref`/`allOf` 전개는 컴파일 시점에 완료. 재귀 정의는 사이클을 끊는
//!   `Ref` 노드로 남고 정의 IR은 공유 `OnceLock` 에 메모이즈된다. 컴파일이
//!   성공하면 도달한 모든 `Ref` 슬롯이 채워진 상태가 보장된다(실패한 정의
//!   컴파일은 전체 Err 로 귀결되어 코덱이 만들어지지 않음).
//! - `option_inner`(type:[T,null] / anyOf:[T,null]) 해석을 `Option` 노드로
//!   고정 — 런타임 inner 재구성 클론 제거.
//! - oneOf 변형 정렬(`variant_key` 유도+사전순)과 판별자 검출, 변형 매칭/
//!   본체 디스패치 결정을 `IrVariant` 에 고정 — 원본 `matches_variant` /
//!   `encode_variant` / `decode_variant` 는 raw 변형 스키마 모양을 보므로
//!   그 결정 트리를 컴파일 시점에 동일 순서로 밟아 스냅샷한다.
//! - enum 이 const 검사보다 앞서고(encode/decode 공통), const 는 encode 에서
//!   값 검사 후 타입 폴스루, decode 에서는 무시(원본 decode_node 에 const
//!   분기가 없음)하는 분기 순서도 그대로 유지한다.
//!
//! 원본이 지원하지 않는 스키마는 IR 도 지원하지 않는다(동일 에러 문자열 —
//! 빌드 시 Err 로 귀결되고, 핸들러가 그 에러를 호출 시점에 재방출한다).
//! 튜플 `items` 배열은 원본이 지원하므로 IR 에서도 길이 일치 검사로 지원한다.

use super::complex_codec_schema::{error, option_inner, ref_name};
use super::complex_codec_variants::{explicit_variant_keys, variant_key};
use crate::{Result, RustraError};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

/// 컴파일된 complex 스키마 노드.
#[derive(Debug)]
pub(crate) enum IrNode {
    /// `type: "string"` — len+bytes.
    String,
    /// `type: "boolean"` — 1바이트.
    Boolean,
    /// `type: "integer"` — `uint*` 포맷이면 uvar, 아니면 zigzag.
    Int { unsigned: bool },
    /// `type: "number"` — `float` 포맷이면 f32, 아니면 f64 (LE 고정폭).
    Float { single: bool },
    /// `type: "null"` — 와이어 0바이트.
    Null,
    /// 배열 — `tuple` 은 `items` 배열 케이스(길이 일치 검사), `items` 는
    /// 단일 반복 노드. 컴파일 시점에 어느 쪽인지 고정된다.
    Seq {
        tuple: Option<Vec<Arc<IrNode>>>,
        items: Option<Arc<IrNode>>,
    },
    /// Option — presence 바이트 1개 + 내부 노드 (option_inner 해석 완료).
    Option { inner: Arc<IrNode> },
    /// struct — 프로퍼티 declaration 순서 고정, 선택 필드 presence 태그.
    Struct {
        fields: Vec<IrField>,
        required: Vec<bool>,
    },
    /// map — `additionalProperties` 값 스키마. 키는 사전순(varint+key+value).
    Map { value: Arc<IrNode> },
    /// enum — 값 목록 (인덱스 uvar). 원본 분기에서 enum 이 const/type 보다
    /// 앞서므로 enum 유무가 이 노드로 붕괴한다.
    Enum { values: Arc<[Value]> },
    /// const — encode: 값 일치 검사 후 `inner` 폴스루, decode: `inner` 만
    /// 읽는다(원본 decode_node 에 const 분기가 없어 const 를 무시하고 타입으로
    /// 읽는다). `inner` 가 없으면(=const 단독) 원본과 동일하게
    /// `unsupported schema type None` 이 된다 — const 단독 본체는 변형 경로
    /// (`IrBody::ConstValue`)에서만 와이어 0바이트로 처리된다.
    Const {
        value: Value,
        inner: Option<Arc<IrNode>>,
    },
    /// data enum / union — 정렬 완료 변형.
    OneOf { variants: Vec<IrVariant> },
    /// 재귀 `$ref` — 정의 IR 로 1-hop(원본이 `$ref` 를 인라인 해석하듯 깊이
    /// 카운터를 바꾸지 않는다). 정의 IR 은 컴파일 성공 시 채워진 공유
    /// `OnceLock` 에 메모이즈된다.
    Ref { target: Arc<OnceLock<Arc<IrNode>>> },
}

/// struct 필드 — 이름과 컴파일된 타입 노드.
#[derive(Debug)]
pub(crate) struct IrField {
    pub name: String,
    pub node: Arc<IrNode>,
}

/// 변형 매칭 결정 — 원본 `matches_variant` 의 순서를 컴파일 시점에 밟아
/// 고정한 것. 런타임은 이 결정만 값에 적용한다.
#[derive(Debug)]
pub(crate) enum IrMatcher {
    /// 판별자 일치 — `IrVariant::discriminator` 의 (필드명, 태그).
    Discriminator,
    /// 단일 프로퍼티 키 존재 여부.
    SingleProperty { key: String },
    /// const 값 일치.
    ConstEq(Value),
    /// 단일 enum 값 일치.
    EnumSingle(Value),
    /// type string 폴백 — 값이 문자열.
    AnyString,
    /// type object 폴백 — 값이 객체.
    AnyObject,
    /// 매칭 불가 (원본 폴백 false).
    Never,
}

/// 변형 본체 디스패치 — 원본 `encode_variant`/`decode_variant` 의 순서를
/// 컴파일 시점에 밟아 고정한 것.
#[derive(Debug)]
pub(crate) enum IrBody {
    /// 판별자 struct — 본체 struct 노드를 판별자 필드를 제외하고
    /// 인코딩/디코딩한다. decode 는 결과 객체에 판별자 (필드명, 태그) 를 심고
    /// encode 는 값이 객체임을 요구한다(`expected enum object`).
    Tagged { node: Arc<IrNode> },
    /// 단일 프로퍼티 언래핑 — 본체는 프로퍼티 값만 인코딩/디코딩.
    UnwrapSingle { key: String, node: Arc<IrNode> },
    /// const 본체 — encode 0바이트, decode 는 값 복제.
    ConstValue(Value),
    /// enum 본체 — encode 0바이트, decode 는 첫 값.
    EnumFirst(Value),
    /// 폴스루 — 변형 전체 노드 인코딩/디코딩.
    Node(Arc<IrNode>),
}

/// 정렬 완료된 oneOf 변형.
#[derive(Debug)]
pub(crate) struct IrVariant {
    /// 정렬 키 — `variant_key` 유도 결과(explicit 순서 키 포함). 와이어 변형
    /// 인덱스는 이 키의 사전순 순번이고, serde 유도 코드가 매칭하는 변형
    /// 이름(또는 태그 값)도 schemars 스키마에서는 이 키와 일치한다 — 직결
    /// 경로(complex_serde)가 인덱스↔이름 대응에 쓴다.
    pub key: String,
    /// 변형 판별자 — 변형이 const 프로퍼티를 가진 struct 면 (필드명, 태그).
    pub discriminator: Option<(String, Value)>,
    /// 변형 매칭 결정.
    pub matcher: IrMatcher,
    /// 변형 본체 디스패치.
    pub body: IrBody,
}

/// 컴파일 실패/미지원 스키마 에러 (원본과 동일 문자열).
fn ir_error(message: impl Into<String>) -> RustraError {
    error(message)
}

/// `$ref` 전개 깊이 한도 — 기존 `resolved_schema` 와 동일.
const MAX_DEPTH: usize = 32;

/// 스키마 → IR 컴파일 (진입점).
pub(crate) fn compile(schema: &Value, definitions: &Value) -> Result<Arc<IrNode>> {
    let mut context = Context {
        definitions,
        defs: HashMap::new(),
    };
    context.compile_node(schema, 0)
}

/// 컴파일-로컬 상태. `defs` 는 정의별 공유 `OnceLock` 슬롯 — 등록으로 재진입
/// (사이클)을 검출하고, 정의 컴파일 성공 시 채운다.
struct Context<'a> {
    definitions: &'a Value,
    defs: HashMap<String, Arc<OnceLock<Arc<IrNode>>>>,
}

impl<'a> Context<'a> {
    /// `resolved_schema` + `decode_node`/`encode_node` 분기 순서의 컴파일
    /// 버전: $ref → allOf → option_inner → oneOf → enum → const → type.
    fn compile_node(&mut self, schema: &Value, depth: usize) -> Result<Arc<IrNode>> {
        if depth > MAX_DEPTH {
            return Err(error("schema reference depth exceeded"));
        }
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            return self.compile_ref(ref_name(reference), reference, depth);
        }
        if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
            if all_of.len() != 1 {
                return Err(error("complex codec does not support multi-entry allOf"));
            }
            return self.compile_node(&all_of[0], depth + 1);
        }
        if let Some(inner) = option_inner(schema) {
            return Ok(Arc::new(IrNode::Option {
                inner: self.compile_node(&inner, depth + 1)?,
            }));
        }
        if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
            return self.compile_one_of(schema, one_of, depth);
        }
        if let Some(values) = schema.get("enum").and_then(Value::as_array) {
            return Ok(Arc::new(IrNode::Enum {
                values: values.clone().into(),
            }));
        }
        if let Some(constant) = schema.get("const") {
            // const+type 공존 — encode 는 const 검사 후 타입 폴스루, decode 는
            // const 를 무시하고 타입으로 읽는다. 타입 노드는 const 를 떼어낸
            // 사본에서 컴파일한다.
            let inner = if schema.get("type").is_some() {
                let mut without_const = schema.clone();
                if let Some(object) = without_const.as_object_mut() {
                    object.remove("const");
                }
                Some(self.compile_node(&without_const, depth)?)
            } else {
                None
            };
            return Ok(Arc::new(IrNode::Const {
                value: constant.clone(),
                inner,
            }));
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("boolean") => Ok(Arc::new(IrNode::Boolean)),
            Some("integer") => {
                let unsigned = schema
                    .get("format")
                    .and_then(Value::as_str)
                    .is_some_and(|format| format.starts_with("uint"));
                Ok(Arc::new(IrNode::Int { unsigned }))
            }
            Some("number") => Ok(Arc::new(IrNode::Float {
                single: schema.get("format").and_then(Value::as_str) == Some("float"),
            })),
            Some("string") => Ok(Arc::new(IrNode::String)),
            Some("null") => Ok(Arc::new(IrNode::Null)),
            Some("array") => self.compile_array(schema, depth),
            Some("object") => self.compile_object(schema, depth),
            other => Err(ir_error(format!("unsupported schema type {other:?}"))),
        }
    }

    /// `$ref` 정의 컴파일 — 메모이제이션과 사이클 절단. 첫 진입에서 슬롯을
    /// 등록하고 정의를 컴파일; 진행 중 재진입이면 `Ref` 노드로 끊는다.
    fn compile_ref(&mut self, name: &str, reference: &str, depth: usize) -> Result<Arc<IrNode>> {
        if let Some(slot) = self.defs.get(name) {
            return match slot.get() {
                Some(compiled) => Ok(compiled.clone()),
                None => Ok(Arc::new(IrNode::Ref {
                    target: slot.clone(),
                })),
            };
        }
        let definition = self
            .definitions
            .get(name)
            .ok_or_else(|| error(format!("missing schema definition {reference}")))?;
        let slot = Arc::new(OnceLock::new());
        self.defs.insert(name.to_string(), slot.clone());
        let compiled = self.compile_node(definition, depth + 1)?;
        let _ = slot.set(compiled.clone());
        Ok(compiled)
    }

    fn compile_array(&mut self, schema: &Value, depth: usize) -> Result<Arc<IrNode>> {
        let Some(items) = schema.get("items") else {
            return Err(ir_error("array schema is missing items"));
        };
        match items {
            Value::Array(items) => {
                let tuple = items
                    .iter()
                    .map(|item| self.compile_node(item, depth + 1))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Arc::new(IrNode::Seq {
                    tuple: Some(tuple),
                    items: None,
                }))
            }
            items if !items.is_boolean() => Ok(Arc::new(IrNode::Seq {
                tuple: None,
                items: Some(self.compile_node(items, depth + 1)?),
            })),
            _ => Err(ir_error("array schema is missing items")),
        }
    }

    /// struct/map 결정 — 원본 `encode_object_or_map`/`decode_object_or_map` 의
    /// `additionalProperties.is_some() && properties.is_none()` 조건 그대로.
    /// additionalProperties 와 properties 가 공존하면 struct 로 처리된다.
    fn compile_object(&mut self, schema: &Value, depth: usize) -> Result<Arc<IrNode>> {
        if schema.get("additionalProperties").is_some() && schema.get("properties").is_none() {
            let Some(value_schema) = schema
                .get("additionalProperties")
                .filter(|schema| !schema.is_boolean())
            else {
                return Err(ir_error("map schema is missing value type"));
            };
            return Ok(Arc::new(IrNode::Map {
                value: self.compile_node(value_schema, depth + 1)?,
            }));
        }
        let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
            // properties 없는 object — 원본 encode_object 는 아무 바이트도
            // 쓰지 않고 decode_object 는 빈 객체를 만든다. 필드 없는 struct.
            return Ok(Arc::new(IrNode::Struct {
                fields: Vec::new(),
                required: Vec::new(),
            }));
        };
        self.compile_struct(schema, properties, depth)
    }

    /// struct 컴파일 — `properties` declaration 순서 그대로, `required` 는
    /// 스키마(또는 변형)의 배열에서 읽는다.
    fn compile_struct(
        &mut self,
        schema: &Value,
        properties: &serde_json::Map<String, Value>,
        depth: usize,
    ) -> Result<Arc<IrNode>> {
        let required: BTreeSet<&str> = schema
            .get("required")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut fields = Vec::with_capacity(properties.len());
        let mut required_flags = Vec::with_capacity(properties.len());
        for (name, field_schema) in properties {
            fields.push(IrField {
                name: name.clone(),
                node: self.compile_node(field_schema, depth + 1)?,
            });
            required_flags.push(required.contains(name.as_str()));
        }
        Ok(Arc::new(IrNode::Struct {
            fields,
            required: required_flags,
        }))
    }

    fn compile_one_of(
        &mut self,
        schema: &Value,
        one_of: &[Value],
        depth: usize,
    ) -> Result<Arc<IrNode>> {
        // variants() 미러 — 키 유도(explicit → variant_key), 사전순 정렬,
        // 중복 키 거부.
        let explicit = explicit_variant_keys(schema);
        let mut ordered: Vec<(String, &Value)> = one_of
            .iter()
            .enumerate()
            .map(|(index, variant)| {
                let key = explicit
                    .as_ref()
                    .and_then(|keys| keys.get(index).cloned())
                    .or_else(|| variant_key(variant, index))
                    .ok_or_else(|| {
                        ir_error("enum variants require a stable key or explicit metadata")
                    })?;
                Ok((key, variant))
            })
            .collect::<Result<_>>()?;
        ordered.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
        for pair in ordered.windows(2) {
            if pair[0].0 == pair[1].0 {
                return Err(ir_error("enum variant keys must be unique"));
            }
        }
        let variants = ordered
            .into_iter()
            .map(|(key, variant)| {
                let variant = self.compile_variant(variant, depth)?;
                Ok(IrVariant { key, ..variant })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Arc::new(IrNode::OneOf { variants }))
    }

    /// 변형 컴파일 — discriminator 검출, matcher, body 를 원본 순서대로 밟아
    /// 고정한다(원본은 raw 변형 스키마 모양을 보고 분기).
    fn compile_variant(&mut self, variant: &Value, depth: usize) -> Result<IrVariant> {
        let properties = variant.get("properties").and_then(Value::as_object);
        let discriminator = properties.and_then(|properties| {
            properties
                .iter()
                .find_map(|(key, value)| value.get("const").map(|tag| (key.clone(), tag.clone())))
        });
        // matches_variant 순서: discriminator → 단일 프로퍼티 → const →
        // 단일 enum → type 폴백(string/object) → Never.
        let matcher = if discriminator.is_some() {
            IrMatcher::Discriminator
        } else if let Some(properties) = properties.filter(|properties| properties.len() == 1) {
            IrMatcher::SingleProperty {
                key: properties.keys().next().unwrap().clone(),
            }
        } else if let Some(constant) = variant.get("const") {
            IrMatcher::ConstEq(constant.clone())
        } else if let Some(values) = variant.get("enum").and_then(Value::as_array)
            && values.len() == 1
        {
            IrMatcher::EnumSingle(values[0].clone())
        } else {
            match variant.get("type").and_then(Value::as_str) {
                Some("string") => IrMatcher::AnyString,
                Some("object") => IrMatcher::AnyObject,
                _ => IrMatcher::Never,
            }
        };
        // encode_variant/decode_variant 순서: discriminator → 단일 프로퍼티 →
        // const → enum → 폴스루. Tagged 본체는 raw properties 에서 직접 struct
        // 를 컴파일한다 — 원본 encode_object/decode_object 가 $ref/type 재해석
        // 없이 properties/required 만 보기 때문.
        let body = if discriminator.is_some() {
            let node = match properties {
                Some(properties) => self.compile_struct(variant, properties, depth + 1)?,
                None => Arc::new(IrNode::Struct {
                    fields: Vec::new(),
                    required: Vec::new(),
                }),
            };
            IrBody::Tagged { node }
        } else if let Some(properties) = properties.filter(|properties| properties.len() == 1) {
            let key = properties.keys().next().unwrap().clone();
            let node = self.compile_node(&properties[&key], depth + 1)?;
            IrBody::UnwrapSingle { key, node }
        } else if let Some(constant) = variant.get("const") {
            IrBody::ConstValue(constant.clone())
        } else if let Some(values) = variant.get("enum").and_then(Value::as_array) {
            IrBody::EnumFirst(
                values
                    .first()
                    .cloned()
                    .ok_or_else(|| ir_error("enum variant is empty"))?,
            )
        } else {
            IrBody::Node(self.compile_node(variant, depth + 1)?)
        };
        Ok(IrVariant {
            key: String::new(),
            discriminator,
            matcher,
            body,
        })
    }
}
