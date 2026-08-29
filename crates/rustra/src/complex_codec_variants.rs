use super::complex_codec_schema::{error, type_name};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

pub(crate) fn sorted_map_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    keys
}

pub(crate) fn variant_key(schema: &Value, _index: usize) -> Option<String> {
    if let Some(value) = schema.get("const").and_then(Value::as_str) {
        return Some(value.to_string());
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array)
        && values.len() == 1
    {
        return Some(variant_value_key(&values[0]));
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        if let Some(value) = properties
            .values()
            .find_map(|property| property.get("const"))
        {
            return Some(variant_value_key(value));
        }
        if properties.len() == 1 {
            return Some(properties.keys().next().unwrap().clone());
        }
    }
    schema
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn explicit_variant_keys(schema: &Value) -> Option<Vec<String>> {
    let one_of = schema.get("oneOf")?.as_array()?;
    let keys = schema
        .get("x-rustra-variant-order")?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()?;
    if keys.len() != one_of.len() {
        return None;
    }
    let mut unique = BTreeSet::new();
    let keys = keys.into_iter().map(str::to_string).collect::<Vec<_>>();
    keys.iter()
        .all(|key| unique.insert(key.clone()))
        .then_some(keys)
}

fn variant_value_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

pub(crate) fn annotate_variant_order(value: &mut Value) {
    let Value::Object(object) = value else {
        return;
    };
    let derived = object
        .get("oneOf")
        .and_then(Value::as_array)
        .and_then(|variants| {
            variants
                .iter()
                .enumerate()
                .map(|(index, variant)| variant_key(variant, index))
                .collect::<Option<Vec<_>>>()
        });
    if object.get("x-rustra-variant-order").is_none()
        && let Some(keys) = derived
        && keys.iter().collect::<BTreeSet<_>>().len() == keys.len()
    {
        object.insert("x-rustra-variant-order".into(), json!(keys));
    }
    for child in object.values_mut() {
        annotate_variant_order(child);
    }
}

pub(crate) fn variants(schema: &Value) -> super::Result<Vec<(Value, String)>> {
    let one_of = schema
        .get("oneOf")
        .and_then(Value::as_array)
        .ok_or_else(|| error("enum schema is missing oneOf"))?;
    let explicit = explicit_variant_keys(schema);
    let mut result = one_of
        .iter()
        .enumerate()
        .map(|(index, variant)| {
            let key = explicit
                .as_ref()
                .and_then(|keys| keys.get(index).cloned())
                .or_else(|| variant_key(variant, index))
                .ok_or_else(|| error("enum variants require a stable key or explicit metadata"))?;
            Ok((variant.clone(), key))
        })
        .collect::<super::Result<Vec<_>>>()?;
    result.sort_by(|left, right| left.1.as_bytes().cmp(right.1.as_bytes()));
    for pair in result.windows(2) {
        if pair[0].1 == pair[1].1 {
            return Err(error("enum variant keys must be unique"));
        }
    }
    Ok(result)
}

pub(crate) fn discriminator(schema: &Value) -> Option<(String, Value)> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| {
            properties
                .iter()
                .find_map(|(key, value)| value.get("const").map(|tag| (key.clone(), tag.clone())))
        })
}

pub(crate) fn values_equal(left: &Value, right: &Value) -> bool {
    left == right
}

pub(crate) fn matches_variant(schema: &Value, value: &Value) -> bool {
    if let Some((key, tag)) = discriminator(schema) {
        return value
            .as_object()
            .and_then(|object| object.get(&key))
            .is_some_and(|candidate| values_equal(candidate, &tag));
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object)
        && properties.len() == 1
    {
        return value
            .as_object()
            .is_some_and(|object| object.contains_key(properties.keys().next().unwrap()));
    }
    if let Some(constant) = schema.get("const") {
        return values_equal(constant, value);
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array)
        && values.len() == 1
    {
        return values_equal(&values[0], value);
    }
    match type_name(schema) {
        Some("string") => value.is_string(),
        Some("object") => value.is_object(),
        _ => false,
    }
}
