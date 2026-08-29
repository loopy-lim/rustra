use super::complex_codec_encode_object::{encode_object_or_map, encode_variant};
use super::{
    ComplexCodecLimits, Result,
    complex_codec_schema::{error, is_unsigned, option_inner, resolved_schema, type_name},
    complex_codec_variants::{matches_variant, variants},
    complex_codec_wire::Writer,
};
use serde_json::Value;

pub(crate) fn encode_node(
    writer: &mut Writer,
    raw_schema: &Value,
    value: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    if depth > limits.max_depth {
        return Err(error(format!("value depth exceeds {}", limits.max_depth)));
    }
    let schema = resolved_schema(raw_schema, definitions, limits, depth)?;
    if let Some(inner) = option_inner(&schema) {
        if value.is_null() {
            writer.byte(0)?;
        } else {
            writer.byte(1)?;
            encode_node(writer, &inner, value, definitions, limits, depth + 1)?;
        }
        return Ok(());
    }
    if schema.get("oneOf").is_some() {
        let choices = variants(&schema)?;
        let selected = choices
            .iter()
            .position(|(variant, _)| matches_variant(variant, value))
            .ok_or_else(|| error("value does not match any enum variant"))?;
        writer.varint(selected as u128)?;
        return encode_variant(
            writer,
            &choices[selected].0,
            value,
            definitions,
            limits,
            depth + 1,
        );
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let selected = values
            .iter()
            .position(|candidate| candidate == value)
            .ok_or_else(|| error("value is not a member of enum"))?;
        return writer.varint(selected as u128);
    }
    if let Some(constant) = schema.get("const")
        && constant != value
    {
        return Err(error(format!("value does not match const {constant}")));
    }
    match type_name(&schema) {
        Some("boolean") => writer.byte(
            if value.as_bool().ok_or_else(|| error("expected boolean"))? {
                1
            } else {
                0
            },
        ),
        Some("integer") => {
            if is_unsigned(&schema) {
                writer.varint(value_as_u128(value)?)
            } else {
                writer.zigzag(value_as_i128(value)?)
            }
        }
        Some("number") => {
            let number = value
                .as_f64()
                .ok_or_else(|| error("expected finite number"))?;
            if !number.is_finite() {
                return Err(error("expected finite number"));
            }
            if schema.get("format").and_then(Value::as_str) == Some("float") {
                writer.push(&(number as f32).to_le_bytes())
            } else {
                writer.push(&number.to_le_bytes())
            }
        }
        Some("string") => writer.string(value.as_str().ok_or_else(|| error("expected string"))?),
        Some("null") => {
            if value.is_null() {
                Ok(())
            } else {
                Err(error("expected null"))
            }
        }
        Some("array") => encode_array(writer, &schema, value, definitions, limits, depth),
        Some("object") => encode_object_or_map(writer, &schema, value, definitions, limits, depth),
        other => Err(error(format!("unsupported schema type {other:?}"))),
    }
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

fn encode_array(
    writer: &mut Writer,
    schema: &Value,
    value: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    let values = value.as_array().ok_or_else(|| error("expected array"))?;
    if values.len() > limits.max_collection_length {
        return Err(error(format!(
            "collection length exceeds {}",
            limits.max_collection_length
        )));
    }
    writer.varint(values.len() as u128)?;
    match schema.get("items") {
        Some(Value::Array(items)) => {
            if items.len() != values.len() {
                return Err(error("tuple length mismatch"));
            }
            for (item_schema, item) in items.iter().zip(values) {
                encode_node(writer, item_schema, item, definitions, limits, depth + 1)?;
            }
            Ok(())
        }
        Some(items) if !items.is_boolean() => {
            for item in values {
                encode_node(writer, items, item, definitions, limits, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(error("array schema is missing items")),
    }
}
