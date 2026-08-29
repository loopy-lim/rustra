use super::complex_codec_encode::encode_node;
use super::{
    ComplexCodecLimits, Result,
    complex_codec_schema::error,
    complex_codec_variants::{discriminator, sorted_map_keys},
    complex_codec_wire::Writer,
};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub(crate) fn encode_object_or_map(
    writer: &mut Writer,
    schema: &Value,
    value: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    let object = value.as_object().ok_or_else(|| error("expected object"))?;
    if schema.get("additionalProperties").is_some() && schema.get("properties").is_none() {
        let value_schema = schema
            .get("additionalProperties")
            .filter(|schema| !schema.is_boolean())
            .ok_or_else(|| error("map schema is missing value type"))?;
        let keys = sorted_map_keys(object);
        if keys.len() > limits.max_collection_length {
            return Err(error(format!(
                "collection length exceeds {}",
                limits.max_collection_length
            )));
        }
        writer.varint(keys.len() as u128)?;
        for key in keys {
            writer.string(key)?;
            encode_node(
                writer,
                value_schema,
                &object[key],
                definitions,
                limits,
                depth + 1,
            )?;
        }
        return Ok(());
    }
    encode_object(writer, schema, object, definitions, limits, depth, None)
}

fn encode_object(
    writer: &mut Writer,
    schema: &Value,
    value: &Map<String, Value>,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
    skip_key: Option<&str>,
) -> Result<()> {
    let required: BTreeSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for (key, field_schema) in schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|properties| properties.iter())
    {
        if skip_key == Some(key.as_str()) {
            continue;
        }
        let present = value.contains_key(key);
        if !required.contains(key.as_str()) {
            writer.byte(u8::from(present))?;
        }
        if present {
            encode_node(
                writer,
                field_schema,
                &value[key],
                definitions,
                limits,
                depth + 1,
            )?;
        } else if required.contains(key.as_str()) {
            return Err(error(format!("missing required field {key}")));
        }
    }
    Ok(())
}

pub(crate) fn encode_variant(
    writer: &mut Writer,
    schema: &Value,
    value: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<()> {
    if let Some((key, _)) = discriminator(schema) {
        return encode_object(
            writer,
            schema,
            value
                .as_object()
                .ok_or_else(|| error("expected enum object"))?,
            definitions,
            limits,
            depth,
            Some(&key),
        );
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object)
        && properties.len() == 1
    {
        let key = properties.keys().next().unwrap();
        let variant_value = value
            .as_object()
            .and_then(|object| object.get(key))
            .ok_or_else(|| error(format!("missing enum variant payload {key}")))?;
        return encode_node(
            writer,
            &properties[key],
            variant_value,
            definitions,
            limits,
            depth,
        );
    }
    if schema.get("const").is_some() || schema.get("enum").is_some() {
        return Ok(());
    }
    encode_node(writer, schema, value, definitions, limits, depth)
}

pub(crate) fn complex_encode(
    schema: &Value,
    definitions: &Value,
    value: &Value,
    limits: ComplexCodecLimits,
) -> Result<Vec<u8>> {
    let mut writer = Writer::new(limits);
    encode_node(&mut writer, schema, value, definitions, limits, 0)?;
    Ok(writer.finish())
}

pub(crate) fn complex_encode_into(
    schema: &Value,
    definitions: &Value,
    value: &Value,
    target: &mut [u8],
    limits: ComplexCodecLimits,
) -> Result<usize> {
    let mut writer = Writer::into_slice(target, limits);
    encode_node(&mut writer, schema, value, definitions, limits, 0)?;
    Ok(writer.written)
}
