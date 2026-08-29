use super::{
    ComplexCodecLimits, Result,
    complex_codec_schema::error,
    complex_codec_wire::Writer,
    complex_schema_ir::{IrBody, IrMatcher, IrNode, IrVariant},
};
use serde_json::Value;

/// 컴파일된 IR 을 순회하는 인코더 — 와이어는 기존 `&Value` 스키마 해석
/// 버전과 바이트 단위로 동일하다. 원본 분기 순서(옵션 태그, oneOf 인덱스,
/// enum 인덱스, const 검사, 타입 디스패치)와 에러 문자열을 유지한다.
pub(crate) fn encode_node_ir(
    writer: &mut Writer,
    ir: &IrNode,
    value: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    if depth > limits.max_depth {
        return Err(error(format!("value depth exceeds {}", limits.max_depth)));
    }
    match ir {
        IrNode::Option { inner } => {
            if value.is_null() {
                writer.byte(0)
            } else {
                writer.byte(1)?;
                encode_node_ir(writer, inner, value, limits, depth + 1)
            }
        }
        IrNode::OneOf { variants } => {
            let selected = variants
                .iter()
                .position(|variant| variant_matches(variant, value))
                .ok_or_else(|| error("value does not match any enum variant"))?;
            writer.varint(selected as u128)?;
            encode_variant_ir(writer, &variants[selected], value, limits, depth + 1)
        }
        IrNode::Enum { values } => {
            let selected = values
                .iter()
                .position(|candidate| candidate == value)
                .ok_or_else(|| error("value is not a member of enum"))?;
            writer.varint(selected as u128)
        }
        IrNode::Const {
            value: constant,
            inner,
        } => {
            if constant != value {
                return Err(error(format!("value does not match const {constant}")));
            }
            match inner {
                Some(node) => encode_node_ir(writer, node, value, limits, depth),
                None => Ok(()),
            }
        }
        IrNode::Boolean => writer.byte(
            if value.as_bool().ok_or_else(|| error("expected boolean"))? {
                1
            } else {
                0
            },
        ),
        IrNode::Int { unsigned } => {
            if *unsigned {
                writer.varint(value_as_u128(value)?)
            } else {
                writer.zigzag(value_as_i128(value)?)
            }
        }
        IrNode::Float { single } => {
            let number = value
                .as_f64()
                .ok_or_else(|| error("expected finite number"))?;
            if !number.is_finite() {
                return Err(error("expected finite number"));
            }
            if *single {
                writer.push(&(number as f32).to_le_bytes())
            } else {
                writer.push(&number.to_le_bytes())
            }
        }
        IrNode::String => writer.string(value.as_str().ok_or_else(|| error("expected string"))?),
        IrNode::Null => {
            if value.is_null() {
                Ok(())
            } else {
                Err(error("expected null"))
            }
        }
        IrNode::Seq { tuple, items } => {
            let values = value.as_array().ok_or_else(|| error("expected array"))?;
            if values.len() > limits.max_collection_length {
                return Err(error(format!(
                    "collection length exceeds {}",
                    limits.max_collection_length
                )));
            }
            writer.varint(values.len() as u128)?;
            if let Some(items) = tuple {
                if items.len() != values.len() {
                    return Err(error("tuple length mismatch"));
                }
                for (item_ir, item) in items.iter().zip(values) {
                    encode_node_ir(writer, item_ir, item, limits, depth + 1)?;
                }
                return Ok(());
            }
            let Some(items) = items else {
                return Err(error("array schema is missing items"));
            };
            for item in values {
                encode_node_ir(writer, items, item, limits, depth + 1)?;
            }
            Ok(())
        }
        IrNode::Struct { .. } => encode_struct_ir(writer, ir, value, None, limits, depth),
        IrNode::Map { value: value_node } => {
            let object = value.as_object().ok_or_else(|| error("expected object"))?;
            let keys = super::complex_codec_variants::sorted_map_keys(object);
            if keys.len() > limits.max_collection_length {
                return Err(error(format!(
                    "collection length exceeds {}",
                    limits.max_collection_length
                )));
            }
            writer.varint(keys.len() as u128)?;
            for key in keys {
                writer.string(key)?;
                encode_node_ir(writer, value_node, &object[key], limits, depth + 1)?;
            }
            Ok(())
        }
        IrNode::Ref { target } => {
            let node = compiled_ref(target)?;
            encode_node_ir(writer, node, value, limits, depth)
        }
    }
}

/// 변형 매칭 — 원본 `matches_variant` 의 결정을 컴파일 시점에 고정한
/// `IrMatcher` 를 값에 적용한다.
fn variant_matches(variant: &IrVariant, value: &Value) -> bool {
    match &variant.matcher {
        IrMatcher::Discriminator => {
            let Some((key, tag)) = &variant.discriminator else {
                return false;
            };
            value
                .as_object()
                .and_then(|object| object.get(key))
                .is_some_and(|candidate| candidate == tag)
        }
        IrMatcher::SingleProperty { key } => value
            .as_object()
            .is_some_and(|object| object.contains_key(key)),
        IrMatcher::ConstEq(constant) => constant == value,
        IrMatcher::EnumSingle(single) => single == value,
        IrMatcher::AnyString => value.is_string(),
        IrMatcher::AnyObject => value.is_object(),
        IrMatcher::Never => false,
    }
}

/// 변형 본체 인코딩 — 원본 `encode_variant` 의 IR 사본.
fn encode_variant_ir(
    writer: &mut Writer,
    variant: &IrVariant,
    value: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    if depth > limits.max_depth {
        return Err(error(format!("value depth exceeds {}", limits.max_depth)));
    }
    match &variant.body {
        IrBody::Tagged { node } => {
            value
                .as_object()
                .ok_or_else(|| error("expected enum object"))?;
            encode_struct_ir(
                writer,
                node,
                value,
                variant.discriminator.as_ref().map(|(key, _)| key.as_str()),
                limits,
                depth,
            )
        }
        IrBody::UnwrapSingle { key, node } => {
            let variant_value = value
                .as_object()
                .and_then(|object| object.get(key))
                .ok_or_else(|| error(format!("missing enum variant payload {key}")))?;
            encode_node_ir(writer, node, variant_value, limits, depth)
        }
        IrBody::ConstValue(_) | IrBody::EnumFirst(_) => Ok(()),
        IrBody::Node(node) => encode_node_ir(writer, node, value, limits, depth),
    }
}

/// struct 인코딩 — 프로퍼티 declaration 순서, 선택 필드 presence 태그,
/// `skip_key` 는 판별자 필드 스킵(원본 encode_object 와 동일).
fn encode_struct_ir(
    writer: &mut Writer,
    ir: &IrNode,
    value: &Value,
    skip_key: Option<&str>,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    let IrNode::Struct { fields, required } = ir else {
        return Err(error("expected object"));
    };
    let object = value.as_object().ok_or_else(|| error("expected object"))?;
    for (index, field) in fields.iter().enumerate() {
        if skip_key == Some(field.name.as_str()) {
            continue;
        }
        let present = object.contains_key(&field.name);
        if !required[index] {
            writer.byte(u8::from(present))?;
        }
        if present {
            encode_node_ir(writer, &field.node, &object[&field.name], limits, depth + 1)?;
        } else if required[index] {
            return Err(error(format!("missing required field {}", field.name)));
        }
    }
    Ok(())
}

/// 컴파일 성공 시 모든 도달 Ref 슬롯이 채워진다 — 빈 슬롯은 컴파일러 버그.
fn compiled_ref(
    target: &std::sync::OnceLock<std::sync::Arc<IrNode>>,
) -> Result<&std::sync::Arc<IrNode>> {
    target
        .get()
        .ok_or_else(|| error("unresolved schema reference"))
}

fn value_as_i128(value: &Value) -> Result<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
        .ok_or_else(|| error("integer must be a JSON integer"))
}

fn value_as_u128(value: &Value) -> Result<u128> {
    value
        .as_u64()
        .map(u128::from)
        .or_else(|| {
            value
                .as_i64()
                .filter(|value| *value >= 0)
                .map(|value| value as u128)
        })
        .ok_or_else(|| error("unsigned integer must be non-negative"))
}
