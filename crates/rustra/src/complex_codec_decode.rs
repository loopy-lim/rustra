use super::complex_codec_decode_object::{decode_object_or_map, decode_variant};
use super::{
    ComplexCodecLimits, Result,
    complex_codec_schema::{error, is_unsigned, option_inner, resolved_schema, type_name},
    complex_codec_variants::variants,
    complex_codec_wire::Reader,
};
use serde_json::{Value, json};

pub(crate) fn decode_node(
    reader: &mut Reader<'_>,
    raw_schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    if depth > limits.max_depth {
        return Err(error(format!("value depth exceeds {}", limits.max_depth)));
    }
    let schema = resolved_schema(raw_schema, definitions, limits, depth)?;
    if let Some(inner) = option_inner(&schema) {
        return match reader.byte()? {
            0 => Ok(Value::Null),
            1 => decode_node(reader, &inner, definitions, limits, depth + 1),
            _ => Err(error("invalid option presence tag")),
        };
    }
    if schema.get("oneOf").is_some() {
        let choices = variants(&schema)?;
        let index = reader.varint()? as usize;
        let variant = choices
            .get(index)
            .ok_or_else(|| error("enum variant index out of range"))?;
        return decode_variant(reader, &variant.0, definitions, limits, depth + 1);
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .get(reader.varint()? as usize)
            .cloned()
            .ok_or_else(|| error("enum index out of range"));
    }
    match type_name(&schema) {
        Some("boolean") => match reader.byte()? {
            0 => Ok(Value::Bool(false)),
            1 => Ok(Value::Bool(true)),
            _ => Err(error("invalid boolean value")),
        },
        Some("integer") => {
            if is_unsigned(&schema) {
                Ok(json!(u64::try_from(reader.varint()?).map_err(
                    |_| error("decoded unsigned integer exceeds u64")
                )?))
            } else {
                let value = reader.zigzag()?;
                i64::try_from(value)
                    .map(|value| json!(value))
                    .map_err(|_| error("decoded integer exceeds JSON safe range"))
            }
        }
        Some("number") => {
            let format = schema.get("format").and_then(Value::as_str);
            let bytes = reader.raw(if format == Some("float") { 4 } else { 8 })?;
            let value = if format == Some("float") {
                f32::from_le_bytes(bytes.try_into().unwrap()) as f64
            } else {
                f64::from_le_bytes(bytes.try_into().unwrap())
            };
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or_else(|| error("decoded non-finite number"))
        }
        Some("string") => Ok(Value::String(reader.string()?)),
        Some("null") => Ok(Value::Null),
        Some("array") => decode_array(reader, &schema, definitions, limits, depth),
        Some("object") => decode_object_or_map(reader, &schema, definitions, limits, depth),
        other => Err(error(format!("unsupported schema type {other:?}"))),
    }
}

fn decode_array(
    reader: &mut Reader<'_>,
    schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    let length = reader.length()?;
    match schema.get("items") {
        Some(Value::Array(items)) => {
            if items.len() != length {
                return Err(error("tuple length mismatch"));
            }
            items
                .iter()
                .map(|item| decode_node(reader, item, definitions, limits, depth + 1))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array)
        }
        Some(items) if !items.is_boolean() => (0..length)
            .map(|_| decode_node(reader, items, definitions, limits, depth + 1))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        _ => Err(error("array schema is missing items")),
    }
}

pub(crate) fn complex_decode(
    schema: &Value,
    definitions: &Value,
    bytes: &[u8],
    limits: ComplexCodecLimits,
) -> Result<Value> {
    let mut reader = Reader::new(bytes, limits)?;
    let value = decode_node(&mut reader, schema, definitions, limits, 0)?;
    if reader.remaining() != 0 {
        return Err(error("trailing bytes in complex payload"));
    }
    Ok(value)
}
