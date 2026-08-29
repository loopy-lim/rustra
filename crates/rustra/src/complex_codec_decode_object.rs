use super::complex_codec_decode::decode_node;
use super::{
    ComplexCodecLimits, Result, complex_codec_schema::error, complex_codec_variants::discriminator,
    complex_codec_wire::Reader,
};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub(crate) fn decode_object_or_map(
    reader: &mut Reader<'_>,
    schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    if schema.get("additionalProperties").is_some() && schema.get("properties").is_none() {
        let value_schema = schema
            .get("additionalProperties")
            .filter(|schema| !schema.is_boolean())
            .ok_or_else(|| error("map schema is missing value type"))?;
        let length = reader.length()?;
        let mut result = Map::new();
        for _ in 0..length {
            let key = reader.string()?;
            if result.contains_key(&key) {
                return Err(error(format!("duplicate map key {key}")));
            }
            result.insert(
                key,
                decode_node(reader, value_schema, definitions, limits, depth + 1)?,
            );
        }
        return Ok(Value::Object(result));
    }
    decode_object(reader, schema, definitions, limits, depth, None).map(Value::Object)
}

fn decode_object(
    reader: &mut Reader<'_>,
    schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
    skip_key: Option<&str>,
) -> Result<Map<String, Value>> {
    let required: BTreeSet<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut result = Map::new();
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, field_schema) in properties {
            if skip_key == Some(key.as_str()) {
                continue;
            }
            let present = if required.contains(key.as_str()) {
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
                    key.clone(),
                    decode_node(reader, field_schema, definitions, limits, depth + 1)?,
                );
            }
        }
    }
    Ok(result)
}

pub(crate) fn decode_variant(
    reader: &mut Reader<'_>,
    schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    if let Some((key, tag)) = discriminator(schema) {
        let mut result = Map::new();
        result.insert(key.clone(), tag);
        result.extend(decode_object(
            reader,
            schema,
            definitions,
            limits,
            depth,
            Some(key.as_str()),
        )?);
        return Ok(Value::Object(result));
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object)
        && properties.len() == 1
    {
        let key = properties.keys().next().unwrap().clone();
        let value = decode_node(reader, &properties[&key], definitions, limits, depth)?;
        let mut result = Map::new();
        result.insert(key, value);
        return Ok(Value::Object(result));
    }
    if let Some(constant) = schema.get("const") {
        return Ok(constant.clone());
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .first()
            .cloned()
            .ok_or_else(|| error("enum variant is empty"));
    }
    decode_node(reader, schema, definitions, limits, depth)
}
