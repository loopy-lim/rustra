use super::{
    ComplexCodecLimits, Result,
    complex_codec_schema::error,
    complex_codec_wire::Reader,
    complex_schema_ir::{IrBody, IrNode, IrVariant},
};
use serde_json::{Value, json};

/// 컴파일된 IR 을 순회하는 디코더 — 런타임 스키마 재해석 없음. 원본
/// `decode_node` 의 분기 순서(옵션 태그, oneOf 인덱스, enum 인덱스, 타입
/// 디스패치)와 에러 문자열을 유지한다.
pub(crate) fn decode_node_ir(
    reader: &mut Reader<'_>,
    ir: &IrNode,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    if depth > limits.max_depth {
        return Err(error(format!("value depth exceeds {}", limits.max_depth)));
    }
    match ir {
        IrNode::Option { inner } => {
            return match reader.byte()? {
                0 => Ok(Value::Null),
                1 => decode_node_ir(reader, inner, limits, depth + 1),
                _ => Err(error("invalid option presence tag")),
            };
        }
        IrNode::OneOf { variants } => {
            let index = reader.varint()? as usize;
            let variant = variants
                .get(index)
                .ok_or_else(|| error("enum variant index out of range"))?;
            return decode_variant_ir(reader, variant, limits, depth + 1);
        }
        IrNode::Enum { values } => {
            return values
                .get(reader.varint()? as usize)
                .cloned()
                .ok_or_else(|| error("enum index out of range"));
        }
        IrNode::Const { value, inner } => {
            // 원본 decode_node 에 const 분기가 없어 const 를 무시하고 타입으로
            // 읽는다. inner 가 없는 const 단독은 컴파일 시점에
            // `unsupported schema type None` 로 실패하므로 런타임 도달 불가
            // (안전 폴백: 값 복제).
            return match inner {
                Some(node) => decode_node_ir(reader, node, limits, depth),
                None => Ok(value.clone()),
            };
        }
        IrNode::Boolean => {
            return match reader.byte()? {
                0 => Ok(Value::Bool(false)),
                1 => Ok(Value::Bool(true)),
                _ => Err(error("invalid boolean value")),
            };
        }
        IrNode::Int { unsigned } => {
            if *unsigned {
                return Ok(json!(
                    u64::try_from(reader.varint()?)
                        .map_err(|_| error("decoded unsigned integer exceeds u64"))?
                ));
            }
            let value = reader.zigzag()?;
            return i64::try_from(value)
                .map(|value| json!(value))
                .map_err(|_| error("decoded integer exceeds JSON safe range"));
        }
        IrNode::Float { single } => {
            let bytes = reader.raw(if *single { 4 } else { 8 })?;
            let value = if *single {
                f32::from_le_bytes(bytes.try_into().unwrap()) as f64
            } else {
                f64::from_le_bytes(bytes.try_into().unwrap())
            };
            return serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or_else(|| error("decoded non-finite number"));
        }
        IrNode::String => return Ok(Value::String(reader.string()?)),
        IrNode::Null => return Ok(Value::Null),
        IrNode::Seq { tuple, items } => {
            let length = reader.length()?;
            if let Some(items) = tuple {
                if items.len() != length {
                    return Err(error("tuple length mismatch"));
                }
                return items
                    .iter()
                    .map(|item| decode_node_ir(reader, item, limits, depth + 1))
                    .collect();
            }
            let Some(items) = items else {
                return Err(error("array schema is missing items"));
            };
            return (0..length)
                .map(|_| decode_node_ir(reader, items, limits, depth + 1))
                .collect();
        }
        IrNode::Struct { .. } => {
            return decode_struct_ir(reader, ir, None, limits, depth).map(Value::Object);
        }
        IrNode::Map { value } => {
            let length = reader.length()?;
            let mut result = serde_json::Map::new();
            for _ in 0..length {
                let key = reader.string()?;
                if result.contains_key(&key) {
                    return Err(error(format!("duplicate map key {key}")));
                }
                result.insert(key, decode_node_ir(reader, value, limits, depth + 1)?);
            }
            return Ok(Value::Object(result));
        }
        IrNode::Ref { target } => {
            let node = compiled_ref(target)?;
            return decode_node_ir(reader, node, limits, depth);
        }
    }
}

/// 변형 본체 디코드 — 원본 `decode_variant` 의 IR 사본.
pub(crate) fn decode_variant_ir(
    reader: &mut Reader<'_>,
    variant: &IrVariant,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    match &variant.body {
        IrBody::Tagged { node } => {
            let mut result = serde_json::Map::new();
            if let Some((key, tag)) = &variant.discriminator {
                result.insert(key.clone(), tag.clone());
            }
            result.extend(decode_struct_ir(
                reader,
                node,
                skip_key_of(variant),
                limits,
                depth,
            )?);
            return Ok(Value::Object(result));
        }
        IrBody::UnwrapSingle { key, node } => {
            let value = decode_node_ir(reader, node, limits, depth)?;
            let mut result = serde_json::Map::new();
            result.insert(key.clone(), value);
            return Ok(Value::Object(result));
        }
        IrBody::ConstValue(value) => return Ok(value.clone()),
        IrBody::EnumFirst(value) => return Ok(value.clone()),
        IrBody::Node(node) => return decode_node_ir(reader, node, limits, depth),
    }
}

/// struct 디코드 — 프로퍼티 declaration 순서, 선택 필드 presence 태그,
/// `skip_key` 는 판별자 필드 스킵(원본 decode_object 와 동일).
fn decode_struct_ir(
    reader: &mut Reader<'_>,
    ir: &IrNode,
    skip_key: Option<&str>,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<serde_json::Map<String, Value>> {
    let IrNode::Struct { fields, required } = ir else {
        return Err(error("expected object"));
    };
    let mut result = serde_json::Map::new();
    for (index, field) in fields.iter().enumerate() {
        if skip_key == Some(field.name.as_str()) {
            continue;
        }
        let present = if required[index] {
            true
        } else {
            match reader.byte()? {
                0 => false,
                1 => true,
                _ => return Err(error("invalid optional field presence tag")),
            }
        };
        if present {
            result.insert(
                field.name.clone(),
                decode_node_ir(reader, &field.node, limits, depth + 1)?,
            );
        }
    }
    Ok(result)
}

/// 컴파일 성공 시 모든 도달 Ref 슬롯이 채워진다 — 빈 슬롯은 컴파일러 버그.
fn compiled_ref(
    target: &std::sync::OnceLock<std::sync::Arc<IrNode>>,
) -> Result<&std::sync::Arc<IrNode>> {
    target
        .get()
        .ok_or_else(|| error("unresolved schema reference"))
}

/// Tagged 본체의 판별자 필드 스킵 키.
fn skip_key_of(variant: &IrVariant) -> Option<&str> {
    variant.discriminator.as_ref().map(|(key, _)| key.as_str())
}
