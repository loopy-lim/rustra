use crate::RustraError;
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) fn error(message: impl Into<String>) -> RustraError {
    RustraError::invalid_args(format!("complex codec: {}", message.into()))
}

pub(crate) fn ref_name(reference: &str) -> &str {
    reference.rsplit('/').next().unwrap_or(reference)
}

pub(crate) fn option_inner(schema: &Value) -> Option<Value> {
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        let non_null: Vec<&Value> = types
            .iter()
            .filter(|value| value.as_str() != Some("null"))
            .collect();
        if types.len() == 2 && non_null.len() == 1 {
            let mut inner = schema.clone();
            if let Some(object) = inner.as_object_mut() {
                object.insert("type".to_string(), non_null[0].clone());
            }
            return Some(inner);
        }
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array)
        && any_of.len() == 2
    {
        let non_null: Vec<&Value> = any_of
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) != Some("null"))
            .collect();
        if non_null.len() == 1 {
            return Some(non_null[0].clone());
        }
    }
    None
}

pub(crate) fn complex_schema_supported(schema: &Value, definitions: &Value) -> bool {
    fn visit(
        schema: &Value,
        definitions: &Value,
        refs: &mut BTreeSet<String>,
        depth: usize,
    ) -> bool {
        if depth > 32 {
            return false;
        }
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            let name = super::complex_codec_schema::ref_name(reference).to_string();
            let Some(definition) = definitions.get(&name) else {
                return false;
            };
            if refs.contains(&name) {
                return true;
            }
            refs.insert(name.clone());
            let supported = visit(definition, definitions, refs, depth + 1);
            refs.remove(&name);
            return supported;
        }
        if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
            return all_of.len() == 1 && visit(&all_of[0], definitions, refs, depth + 1);
        }
        if let Some(inner) = option_inner(schema) {
            return visit(&inner, definitions, refs, depth + 1);
        }
        if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
            let mut keys = BTreeSet::new();
            let Some(variant_keys) = explicit_variant_keys(schema).or_else(|| {
                one_of
                    .iter()
                    .enumerate()
                    .map(|(index, variant)| variant_key(variant, index))
                    .collect()
            }) else {
                return false;
            };
            return !one_of.is_empty()
                && variant_keys.into_iter().all(|key| keys.insert(key))
                && one_of
                    .iter()
                    .all(|variant| visit(variant, definitions, refs, depth + 1));
        }
        if schema.get("enum").is_some() || schema.get("const").is_some() {
            return true;
        }
        if matches!(
            schema.get("type").and_then(Value::as_str),
            Some("boolean" | "integer" | "number" | "string" | "null")
        ) {
            return true;
        }
        if schema.get("type").and_then(Value::as_str) == Some("array") {
            return match schema.get("items") {
                Some(Value::Array(items)) => items
                    .iter()
                    .all(|item| visit(item, definitions, refs, depth + 1)),
                Some(items) if !items.is_boolean() => visit(items, definitions, refs, depth + 1),
                _ => false,
            };
        }
        if schema.get("type").and_then(Value::as_str) == Some("object") {
            if let Some(additional) = schema.get("additionalProperties") {
                if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                    if additional.as_bool() != Some(false) {
                        return false;
                    }
                    return properties
                        .values()
                        .all(|field| visit(field, definitions, refs, depth + 1));
                }
                if additional.is_boolean() {
                    return false;
                }
                return visit(additional, definitions, refs, depth + 1);
            }
            return schema
                .get("properties")
                .and_then(Value::as_object)
                .map(|properties| {
                    properties
                        .values()
                        .all(|field| visit(field, definitions, refs, depth + 1))
                })
                .unwrap_or(true);
        }
        false
    }
    visit(schema, definitions, &mut BTreeSet::new(), 0)
}

use super::complex_codec_variants::{explicit_variant_keys, variant_key};
