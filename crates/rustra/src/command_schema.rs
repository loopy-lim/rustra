/// Existing object-input generated commands can forward one to three required
/// scalar fields, plus the byte-buffer special case, without changing their
/// public signature. Keep this predicate deliberately narrower than the binary
/// codec: nested/optional/general collection inputs stay on `invokeGenerated`.
fn resolve_generated_field_schema<'a>(schema: &'a Value, definitions: &'a Value) -> &'a Value {
    let mut current = schema;
    // Bound resolution so malformed or cyclic third-party schemas fail closed.
    for _ in 0..16 {
        if let Some(reference) = current.get("$ref").and_then(Value::as_str)
            && let Some(name) = reference.strip_prefix("#/definitions/")
            && let Some(resolved) = definitions.get(name)
        {
            current = resolved;
            continue;
        }
        if let Some(parts) = current.get("allOf").and_then(Value::as_array)
            && parts.len() == 1
        {
            current = &parts[0];
            continue;
        }
        break;
    }
    current
}

pub(crate) fn generated_field_names(
    input_schema: &Value,
    definitions: &Value,
) -> Option<Vec<String>> {
    let properties = input_schema.get("properties")?.as_object()?;
    if properties.is_empty() || properties.len() > 3 {
        return None;
    }
    let required = input_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut fields = Vec::with_capacity(properties.len());
    for (name, schema) in properties {
        if !required.contains(name.as_str()) {
            return None;
        }
        let schema = resolve_generated_field_schema(schema, definitions);
        let scalar = matches!(
            schema.get("type").and_then(Value::as_str),
            Some("integer" | "number" | "boolean" | "string")
        );
        let byte_buffer = schema.get("type").and_then(Value::as_str) == Some("array")
            && schema
                .get("items")
                .and_then(|items| items.get("type"))
                .and_then(Value::as_str)
                == Some("integer")
            && schema
                .get("items")
                .and_then(|items| items.get("format"))
                .and_then(Value::as_str)
                == Some("uint8");
        if !scalar && !byte_buffer {
            return None;
        }
        fields.push(name.clone());
    }
    Some(fields)
}

pub(crate) fn generated_byte_field_name(input_schema: &Value) -> Option<String> {
    let properties = input_schema.get("properties")?.as_object()?;
    if properties.len() != 1 {
        return None;
    }
    let (name, schema) = properties.iter().next()?;
    let required = input_schema.get("required")?.as_array()?;
    if required.len() != 1 || required[0].as_str() != Some(name) {
        return None;
    }
    let is_bytes = schema.get("type").and_then(Value::as_str) == Some("array")
        && schema
            .get("items")
            .and_then(|items| items.get("type"))
            .and_then(Value::as_str)
            == Some("integer")
        && schema
            .get("items")
            .and_then(|items| items.get("format"))
            .and_then(Value::as_str)
            == Some("uint8");
    is_bytes.then(|| name.clone())
}
