use super::complex_codec_variants::{explicit_variant_keys, variant_key};
use super::complex_codec_schema::{option_inner, ref_name};
use crate::RustraError;
use std::collections::{BTreeSet, HashMap};

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
