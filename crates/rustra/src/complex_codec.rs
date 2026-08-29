use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

use crate::{Result, RustraError};

#[derive(Debug, Clone, Copy)]
pub(crate) struct ComplexCodecLimits {
    pub max_depth: usize,
    pub max_payload_bytes: usize,
    pub max_collection_length: usize,
}

impl ComplexCodecLimits {
    pub(crate) const DEFAULT: Self = Self {
        max_depth: 32,
        max_payload_bytes: 1024 * 1024,
        max_collection_length: 100_000,
    };
}

fn error(message: impl Into<String>) -> RustraError {
    RustraError::invalid_args(format!("complex codec: {}", message.into()))
}

fn ref_name(reference: &str) -> &str {
    reference.rsplit('/').next().unwrap_or(reference)
}

fn resolved_schema(
    schema: &Value,
    definitions: &Value,
    limits: ComplexCodecLimits,
    depth: usize,
) -> Result<Value> {
    if depth > limits.max_depth {
        return Err(error("schema reference depth exceeded"));
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let definition = definitions
            .get(ref_name(reference))
            .ok_or_else(|| error(format!("missing schema definition {reference}")))?;
        return resolved_schema(definition, definitions, limits, depth + 1);
    }
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        if all_of.len() != 1 {
            return Err(error("complex codec does not support multi-entry allOf"));
        }
        return resolved_schema(&all_of[0], definitions, limits, depth + 1);
    }
    Ok(schema.clone())
}

fn option_inner(schema: &Value) -> Option<Value> {
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

fn is_unsigned(schema: &Value) -> bool {
    schema
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|format| format.starts_with("uint"))
}

fn type_name(schema: &Value) -> Option<&str> {
    schema.get("type").and_then(Value::as_str)
}

/// Mirrors the TypeScript generator's complex-codec support gate. The codec
/// accepts recursive references; runtime depth limits bound recursive values.
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
            let name = ref_name(reference).to_string();
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
            type_name(schema),
            Some("boolean" | "integer" | "number" | "string" | "null")
        ) {
            return true;
        }
        if type_name(schema) == Some("array") {
            return match schema.get("items") {
                Some(Value::Array(items)) => items
                    .iter()
                    .all(|item| visit(item, definitions, refs, depth + 1)),
                Some(items) if !items.is_boolean() => visit(items, definitions, refs, depth + 1),
                _ => false,
            };
        }
        if type_name(schema) == Some("object") {
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

/// 스키마 기반 binary 인코더의 bounded writer.
///
/// 두 가지 저장소 모드를 가진다 — 인코딩 로직(`encode_node` 이하)은 모드와
/// 무관하게 공유된다:
/// - heap: 소유 Vec 에 적립(`complex_encode` 의 기존 와이어).
/// - into: 호스트가 제공한 caller 버퍼 앞부분에 직접 기록. 힙 할당이 없으며
///   버퍼가 부족하면 패닉 대신 `Err`(overflow) — 호출자가 `Buffered` 폴백으로
///   신호를 받는다(caller-buffer into-handler 계약).
struct Writer<'s> {
    heap: Vec<u8>,
    /// into 모드 — `Some` 이면 `heap` 은 쓰이지 않는다.
    into: Option<&'s mut [u8]>,
    written: usize,
    limits: ComplexCodecLimits,
}

impl<'s> Writer<'s> {
    fn new(limits: ComplexCodecLimits) -> Self {
        Self {
            heap: Vec::new(),
            into: None,
            written: 0,
            limits,
        }
    }

    /// caller 버퍼에 직접 기록하는 into 모드로 시작한다.
    fn into_slice(target: &'s mut [u8], limits: ComplexCodecLimits) -> Self {
        Self {
            heap: Vec::new(),
            into: Some(target),
            written: 0,
            limits,
        }
    }

    /// heap 모드의 최종 바이트.
    fn finish(self) -> Vec<u8> {
        debug_assert!(self.into.is_none(), "finish is heap-mode only");
        self.heap
    }

    fn push(&mut self, bytes: &[u8]) -> Result<()> {
        let next_len = self.written.saturating_add(bytes.len());
        if next_len > self.limits.max_payload_bytes {
            return Err(error(format!(
                "payload exceeds {} bytes",
                self.limits.max_payload_bytes
            )));
        }
        match &mut self.into {
            Some(target) => {
                if next_len > target.len() {
                    return Err(error(format!(
                        "caller buffer overflow: {} bytes needed, {} available",
                        next_len,
                        target.len()
                    )));
                }
                target[self.written..next_len].copy_from_slice(bytes);
            }
            None => self.heap.extend_from_slice(bytes),
        }
        self.written = next_len;
        Ok(())
    }

    fn byte(&mut self, value: u8) -> Result<()> {
        self.push(&[value])
    }

    fn varint(&mut self, mut value: u128) -> Result<()> {
        let mut bytes = [0u8; 19];
        let mut length = 0;
        loop {
            let mut next = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                next |= 0x80;
            }
            bytes[length] = next;
            length += 1;
            if value == 0 {
                return self.push(&bytes[..length]);
            }
        }
    }

    fn zigzag(&mut self, value: i128) -> Result<()> {
        let encoded = if value >= 0 {
            (value as u128).saturating_mul(2)
        } else {
            value.unsigned_abs().saturating_mul(2).saturating_sub(1)
        };
        self.varint(encoded)
    }

    fn string(&mut self, value: &str) -> Result<()> {
        self.varint(value.len() as u128)?;
        self.push(value.as_bytes())
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    limits: ComplexCodecLimits,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], limits: ComplexCodecLimits) -> Result<Self> {
        if bytes.len() > limits.max_payload_bytes {
            return Err(error(format!(
                "payload exceeds {} bytes",
                limits.max_payload_bytes
            )));
        }
        Ok(Self {
            bytes,
            offset: 0,
            limits,
        })
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn raw(&mut self, length: usize) -> Result<&'a [u8]> {
        if self.remaining() < length {
            return Err(error("truncated complex payload"));
        }
        let start = self.offset;
        self.offset += length;
        Ok(&self.bytes[start..self.offset])
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(*self.raw(1)?.first().unwrap())
    }

    fn varint(&mut self) -> Result<u128> {
        let mut value = 0u128;
        // postcard 정규형 계약 — 최대 10바이트, 10바이트째 마지막 바이트의
        // payload 는 2^(64%7)−1 = 1 이하. TS _pcDecodeVarint64 / C++ read_uvar /
        // postcard 크레이트와 동일 규칙(비정규 >64-bit 인코딩 무음 수용 방지).
        for (i, shift) in (0..=63u32).step_by(7).enumerate() {
            let byte = self.byte()?;
            if i == 9 && byte & 0x7f > 0x01 {
                return Err(error("varint exceeds 64 bits"));
            }
            value |= u128::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(error("varint is too long"))
    }

    fn zigzag(&mut self) -> Result<i128> {
        let value = self.varint()?;
        Ok(if value & 1 == 0 {
            (value >> 1) as i128
        } else {
            -((value >> 1) as i128) - 1
        })
    }

    fn length(&mut self) -> Result<usize> {
        let value = self.varint()?;
        if value > self.limits.max_collection_length as u128 || value > usize::MAX as u128 {
            return Err(error(format!(
                "collection length exceeds {}",
                self.limits.max_collection_length
            )));
        }
        Ok(value as usize)
    }

    fn string(&mut self) -> Result<String> {
        let length = self.length()?;
        let bytes = self.raw(length)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| error("invalid UTF-8 string"))
    }
}

fn sorted_map_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    keys
}

fn variant_key(schema: &Value, _index: usize) -> Option<String> {
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

fn explicit_variant_keys(schema: &Value) -> Option<Vec<String>> {
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
    if keys.iter().all(|key| unique.insert(key.clone())) {
        Some(keys)
    } else {
        None
    }
}

fn variant_value_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// Add stable variant keys to schemas emitted to clients when the schema itself
/// already exposes enough information to derive them. Anonymous unions remain
/// unannotated and are rejected by the complex route unless a caller supplies
/// `x-rustra-variant-order` explicitly.
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

fn variants(schema: &Value) -> Result<Vec<(Value, String)>> {
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
        .collect::<Result<Vec<_>>>()?;
    result.sort_by(|left, right| left.1.as_bytes().cmp(right.1.as_bytes()));
    for pair in result.windows(2) {
        if pair[0].1 == pair[1].1 {
            return Err(error("enum variant keys must be unique"));
        }
    }
    Ok(result)
}

fn discriminator(schema: &Value) -> Option<(String, Value)> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| {
            properties
                .iter()
                .find_map(|(key, value)| value.get("const").map(|tag| (key.clone(), tag.clone())))
        })
}

fn values_equal(left: &Value, right: &Value) -> bool {
    left == right
}

fn matches_variant(schema: &Value, value: &Value) -> bool {
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

fn encode_node(
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
        encode_variant(
            writer,
            &choices[selected].0,
            value,
            definitions,
            limits,
            depth + 1,
        )
    } else if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let selected = values
            .iter()
            .position(|candidate| values_equal(candidate, value))
            .ok_or_else(|| error("value is not a member of enum"))?;
        writer.varint(selected as u128)
    } else {
        if let Some(constant) = schema.get("const")
            && !values_equal(constant, value)
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
            Some("string") => {
                writer.string(value.as_str().ok_or_else(|| error("expected string"))?)
            }
            Some("null") => {
                if !value.is_null() {
                    return Err(error("expected null"));
                }
                Ok(())
            }
            Some("array") => encode_array(writer, &schema, value, definitions, limits, depth),
            Some("object") => {
                encode_object_or_map(writer, &schema, value, definitions, limits, depth)
            }
            other => Err(error(format!("unsupported schema type {other:?}"))),
        }
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

fn encode_object_or_map(
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
            writer.byte(if present { 1 } else { 0 })?;
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

fn encode_variant(
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

fn decode_node(
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
        let index = reader.varint()?;
        let variant = choices
            .get(index as usize)
            .ok_or_else(|| error("enum variant index out of range"))?;
        return decode_variant(reader, &variant.0, definitions, limits, depth + 1);
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let index = reader.varint()? as usize;
        return values
            .get(index)
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
                if let Ok(value) = i64::try_from(value) {
                    Ok(json!(value))
                } else {
                    Err(error("decoded integer exceeds JSON safe range"))
                }
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

fn decode_object_or_map(
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
            let value = decode_node(reader, value_schema, definitions, limits, depth + 1)?;
            result.insert(key, value);
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
            } else if required.contains(key.as_str()) {
                return Err(error(format!("missing required field {key}")));
            }
        }
    }
    Ok(result)
}

fn decode_variant(
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

/// `complex_encode` 의 caller-buffer 변형 — 힙 할당 없이 `target` 에 직접
/// 기록하고 기록한 바이트 수를 반환한다. 버퍼 부족(`Err`)은 호출자가 기존
/// `Buffered` 폴백으로 처리한다. 와이어는 `complex_encode` 와 동일하다.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_complex_map_option_and_enum() {
        let schema = json!({
            "type": "object",
            "properties": {
                "profiles": { "type": "object", "additionalProperties": { "$ref": "#/definitions/Profile" } },
                "maybeScores": { "anyOf": [{ "type": "array", "items": { "type": "integer" } }, { "type": "null" }] },
                "status": { "oneOf": [
                    { "type": "object", "properties": { "Active": { "type": "object", "properties": { "level": { "type": "integer" } }, "required": ["level"] } }, "required": ["Active"] },
                    { "type": "string", "enum": ["Idle"] }
                ] }
            },
            "required": ["profiles", "maybeScores", "status"]
        });
        let definitions = json!({
            "Profile": {
                "type": "object",
                "properties": { "name": { "type": "string" }, "score": { "type": "integer" } },
                "required": ["name", "score"]
            }
        });
        let value = json!({
            "profiles": {
                "z": { "name": "Zed", "score": -2 },
                "a": { "name": "아", "score": 42 }
            },
            "maybeScores": [1, -2, 300],
            "status": { "Active": { "level": 9 } }
        });
        let limits = ComplexCodecLimits {
            max_depth: 32,
            max_payload_bytes: 1024,
            max_collection_length: 100,
        };
        let bytes = complex_encode(&schema, &definitions, &value, limits).expect("encode");
        let decoded = complex_decode(&schema, &definitions, &bytes, limits).expect("decode");
        assert_eq!(decoded, value);
    }

    #[test]
    fn round_trips_recursive_refs_and_enforces_depth_limit() {
        let schema = json!({ "$ref": "#/definitions/Node" });
        let definitions = json!({
            "Node": {
                "type": "object",
                "properties": {
                    "value": { "type": "integer" },
                    "next": { "anyOf": [{ "$ref": "#/definitions/Node" }, { "type": "null" }] }
                },
                "required": ["value", "next"]
            }
        });
        let value = json!({
            "value": 1,
            "next": { "value": 2, "next": { "value": 3, "next": null } }
        });
        let limits = ComplexCodecLimits {
            max_depth: 16,
            max_payload_bytes: 1024,
            max_collection_length: 100,
        };
        let bytes = complex_encode(&schema, &definitions, &value, limits).expect("encode");
        assert_eq!(
            complex_decode(&schema, &definitions, &bytes, limits).expect("decode"),
            value
        );

        let shallow = ComplexCodecLimits {
            max_depth: 1,
            ..limits
        };
        assert!(complex_encode(&schema, &definitions, &value, shallow).is_err());
    }

    #[test]
    fn rejects_duplicate_map_keys() {
        let schema = json!({
            "type": "object",
            "additionalProperties": { "type": "integer" }
        });
        // [map length=2][key=a][value=0][key=a][value=0]
        let duplicate_key = [2, 1, b'a', 0, 1, b'a', 0];
        assert!(
            complex_decode(
                &schema,
                &json!({}),
                &duplicate_key,
                ComplexCodecLimits::DEFAULT
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_invalid_presence_tags() {
        let schema = json!({
            "type": "object",
            "properties": { "value": { "type": "integer" } },
            "required": []
        });
        // [optional field presence tag=2]
        assert!(complex_decode(&schema, &json!({}), &[2], ComplexCodecLimits::DEFAULT).is_err());
    }

    #[test]
    fn rejects_one_of_variants_without_stable_keys() {
        let schema = json!({
            "oneOf": [{ "type": "string" }, { "type": "integer" }]
        });
        assert!(!complex_schema_supported(&schema, &json!({})));
        assert!(
            complex_encode(
                &schema,
                &json!({}),
                &json!("value"),
                ComplexCodecLimits::DEFAULT
            )
            .is_err()
        );
    }

    #[test]
    fn accepts_explicit_keys_for_anonymous_one_of_variants() {
        let schema = json!({
            "oneOf": [{ "type": "string" }, { "type": "integer" }],
            "x-rustra-variant-order": ["text", "count"]
        });
        let bytes = complex_encode(
            &schema,
            &json!({}),
            &json!("value"),
            ComplexCodecLimits::DEFAULT,
        )
        .expect("explicit variant metadata should make the union stable");
        assert_eq!(bytes, [1, 5, b'v', b'a', b'l', b'u', b'e']);
    }
}
