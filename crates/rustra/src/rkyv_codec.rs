//! rkyv V2 바이너리 인코딩/디코딩 로직입니다.
//!
//! JSON Schema를 기반으로 고정폭/가변폭 필드를 분석하여
//! 바이트 단위로 값을 읽고 쓰는 클로저를 생성합니다.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{Result, RustraError};

pub(crate) type BinHandler = Arc<dyn Fn(&[u8]) -> Result<Vec<u8>> + Send + Sync>;
pub(crate) type DecodeFn = Arc<dyn Fn(&[u8]) -> Result<Value> + Send + Sync>;
pub(crate) type EncodeFn = Arc<dyn Fn(&Value) -> Vec<u8> + Send + Sync>;

/// Build the Tier 3 JSON fallback decoder.
///
/// Wire format: `[command_id: u16 @0 LE][json_string @2...]`
///
/// Reads bytes after the 2-byte command_id as a UTF-8 JSON string and
/// deserializes it into a [`serde_json::Value`].
pub(crate) fn build_tier3_json_decoder() -> DecodeFn {
    Arc::new(|payload: &[u8]| {
        if payload.len() < 2 {
            return Err(RustraError::invalid_args(
                "rkyv v2 tier3: payload too short for command_id",
            ));
        }
        let json_str = std::str::from_utf8(&payload[2..])
            .map_err(|_| RustraError::invalid_args("rkyv v2 tier3: invalid UTF-8"))?;
        serde_json::from_str(json_str).map_err(|e| {
            RustraError::invalid_args(format!("rkyv v2 tier3: JSON parse failed: {e}"))
        })
    })
}

/// JSON Schema에서 rkyv V2 디코더를 자동 생성합니다.
///
/// 입력 스키마의 프로퍼티를 분석하여 고정폭 필드와 가변폭 필드를 분리하고,
/// 바이트에서 직접 값을 읽어 JSON Value를 재구성하는 클로저를 반환합니다.
///
/// Tier 1: 모든 필드가 고정폭 primitive (i64, i32, f64, …)
/// Tier 2: String 또는 Vec<primitive> 필드 포함
/// Tier 3: 중첩 구조체, enum, Option<T> 등 — 아직 미지원
pub(crate) fn build_rkyv_v2_decoder(input_schema: &Value) -> (DecodeFn, Tier) {
    let props = match input_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => {
            return (
                Arc::new(|_| Err(RustraError::internal("no properties in input schema"))),
                Tier::Tier3,
            );
        }
    };
    let required: BTreeSet<String> = input_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let mut fixed_fields: Vec<(String, usize, WireFieldKind)> = Vec::new();
    let mut var_fields: Vec<(String, WireFieldKind)> = Vec::new();
    let mut tier = Tier::Tier1;

    let mut offset: usize = 8; // command_id u16 + 6B padding

    for (name, prop_schema) in props {
        if !required.contains(name) {
            tier = Tier::Tier3;
            continue;
        }
        let Some(kind) = wire_kind_from_schema(prop_schema) else {
            tier = Tier::Tier3;
            continue;
        };

        if kind.is_fixed() {
            let size = kind.size();
            offset = align_up(offset, size);
            fixed_fields.push((name.clone(), offset, kind));
            offset += size;
        } else {
            tier = if tier == Tier::Tier1 {
                Tier::Tier2
            } else {
                tier
            };
            var_fields.push((name.clone(), kind));
        }
    }

    if tier == Tier::Tier3 {
        return (build_tier3_json_decoder(), Tier::Tier3);
    }

    let var_data_start = offset;

    (
        Arc::new(move |payload: &[u8]| {
            let mut result = serde_json::Map::new();

            for (name, field_offset, kind) in &fixed_fields {
                let val = read_wire_field(payload, *field_offset, *kind)?;
                result.insert(name.clone(), val);
            }

            let mut cursor = var_data_start;
            for (name, kind) in &var_fields {
                if cursor + 4 > payload.len() {
                    return Err(RustraError::invalid_args(
                        "rkyv v2: payload truncated at var-field length",
                    ));
                }
                let len_bytes: [u8; 4] = payload[cursor..cursor + 4].try_into().unwrap();
                let field_len = u32::from_le_bytes(len_bytes) as usize;
                cursor += 4;

                if cursor + field_len > payload.len() {
                    return Err(RustraError::invalid_args(
                        "rkyv v2: payload truncated at var-field data",
                    ));
                }

                let val = match kind {
                    WireFieldKind::String => {
                        let s = std::str::from_utf8(&payload[cursor..cursor + field_len]).map_err(
                            |_| RustraError::invalid_args("rkyv v2: invalid UTF-8 in string field"),
                        )?;
                        json!(s)
                    }
                    WireFieldKind::VecI64 => {
                        read_vec_fixed::<8>(payload, cursor, field_len, |bytes| {
                            json!(i64::from_le_bytes(bytes))
                        })?
                    }
                    WireFieldKind::VecF64 => {
                        read_vec_fixed::<8>(payload, cursor, field_len, |bytes| {
                            json!(f64::from_le_bytes(bytes))
                        })?
                    }
                    WireFieldKind::VecI32 => {
                        read_vec_fixed::<4>(payload, cursor, field_len, |bytes| {
                            json!(i32::from_le_bytes(bytes))
                        })?
                    }
                    WireFieldKind::VecBool => {
                        let mut arr = Vec::with_capacity(field_len);
                        for i in 0..field_len {
                            arr.push(payload[cursor + i] != 0);
                        }
                        json!(arr)
                    }
                    WireFieldKind::VecU8 => {
                        json!(payload[cursor..cursor + field_len])
                    }
                    _ => unreachable!("fixed kind in var_fields"),
                };
                result.insert(name.clone(), val);
                cursor += field_len;
            }

            Ok(Value::Object(result))
        }),
        tier,
    )
}

/// Builds a response encoder that turns a JSON Value (output from invoke_json)
/// into the rkyv V2 binary response format.
///
/// Tier 1/2 wire format:
/// ```text
/// [ok: u8 @0][pad 7B]
/// [fixed output fields @8...][var output fields...]
/// ```
///
/// Tier 3 wire format:
/// ```text
/// [ok: u8 @0][pad 3B][json_len: u32 @4 LE][json_bytes @8...]
/// ```
pub(crate) fn build_rkyv_v2_response_encoder(output_schema: &Value, is_tier3: bool) -> EncodeFn {
    if is_tier3 {
        return Arc::new(move |value: &Value| {
            let json_str = serde_json::to_string(value).unwrap_or_default();
            let json_bytes = json_str.as_bytes();
            let json_len = json_bytes.len() as u32;
            let mut buf = vec![0u8; 8 + json_bytes.len()];
            buf[0] = 1; // ok = true
            buf[4..8].copy_from_slice(&json_len.to_le_bytes());
            buf[8..8 + json_bytes.len()].copy_from_slice(json_bytes);
            buf
        });
    }
    let props = match output_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => {
            return Arc::new(|_| {
                let mut buf = vec![0u8; 8];
                buf[0] = 1;
                buf
            });
        }
    };

    let required: BTreeSet<String> = output_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let mut fixed_fields: Vec<(String, usize, WireFieldKind)> = Vec::new();
    let mut var_fields: Vec<(String, WireFieldKind)> = Vec::new();
    let mut offset: usize = 8;

    let ordered: Vec<_> = props
        .iter()
        .filter(|(name, _)| required.contains(name.as_str()))
        .collect();

    for (name, prop_schema) in &ordered {
        if let Some(kind) = wire_kind_from_schema(prop_schema) {
            if kind.is_fixed() {
                let size = kind.size();
                offset = align_up(offset, size);
                fixed_fields.push(((*name).clone(), offset, kind));
                offset += size;
            } else {
                var_fields.push(((*name).clone(), kind));
            }
        }
    }

    let fixed_end = offset;

    Arc::new(move |value: &Value| {
        let mut buf = vec![0u8; fixed_end];
        buf[0] = 1; // ok = true

        for (name, field_offset, kind) in &fixed_fields {
            let val = value.get(name);
            match kind {
                WireFieldKind::I64 => {
                    let v = val.and_then(Value::as_i64).unwrap_or(0);
                    buf[*field_offset..*field_offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::I32 => {
                    let v = val.and_then(Value::as_i64).unwrap_or(0) as i32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::U32 => {
                    let v = val.and_then(Value::as_u64).unwrap_or(0) as u32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::U16 => {
                    let v = val.and_then(Value::as_u64).unwrap_or(0) as u16;
                    buf[*field_offset..*field_offset + 2].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::F64 => {
                    let v = val.and_then(Value::as_f64).unwrap_or(0.0);
                    buf[*field_offset..*field_offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::F32 => {
                    let v = val.and_then(Value::as_f64).unwrap_or(0.0) as f32;
                    buf[*field_offset..*field_offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                WireFieldKind::Bool => {
                    buf[*field_offset] = if val.and_then(Value::as_bool).unwrap_or(false) {
                        1
                    } else {
                        0
                    };
                }
                _ => unreachable!("var kind in fixed_fields"),
            }
        }

        for (name, kind) in &var_fields {
            let val = value.get(name);
            match kind {
                WireFieldKind::String => {
                    let s = val.and_then(Value::as_str).unwrap_or("");
                    let s_bytes = s.as_bytes();
                    buf.extend_from_slice(&(s_bytes.len() as u32).to_le_bytes());
                    buf.extend_from_slice(s_bytes);
                }
                WireFieldKind::VecI64 => {
                    encode_vec_fixed(&mut buf, val, 8, |v| v.as_i64().unwrap_or(0).to_le_bytes())
                }
                WireFieldKind::VecF64 => encode_vec_fixed(&mut buf, val, 8, |v| {
                    v.as_f64().unwrap_or(0.0).to_le_bytes()
                }),
                WireFieldKind::VecI32 => encode_vec_fixed(&mut buf, val, 4, |v| {
                    (v.as_i64().unwrap_or(0) as i32).to_le_bytes()
                }),
                WireFieldKind::VecBool => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    buf.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                    for item in arr {
                        buf.push(if item.as_bool().unwrap_or(false) {
                            1
                        } else {
                            0
                        });
                    }
                }
                WireFieldKind::VecU8 => {
                    let arr = val
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or(&[]);
                    buf.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                    for item in arr {
                        buf.push(item.as_u64().unwrap_or(0) as u8);
                    }
                }
                _ => unreachable!("fixed kind in var_fields"),
            }
        }

        buf
    })
}

/// Encodes an rkyv V2 error response.
///
/// Wire format:
/// ```text
/// [ok: u8 @0 = 0][pad 7B][error_len: u16 @8][error_bytes...]
/// ```
pub fn encode_rkyv_v2_error(msg: &str) -> Vec<u8> {
    let msg_bytes = msg.as_bytes();
    let msg_len = msg_bytes.len().min(u16::MAX as usize) as u16;
    let mut buf = vec![0u8; 8 + 2 + msg_len as usize];
    buf[0] = 0; // ok = false
    buf[8..10].copy_from_slice(&msg_len.to_le_bytes());
    buf[10..10 + msg_len as usize].copy_from_slice(&msg_bytes[..msg_len as usize]);
    buf.truncate(10 + msg_len as usize);
    buf
}

/// Determines which serialisation tier a command belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    /// All fields are fixed-width primitives (i64, i32, f64, …).
    Tier1,
    /// Has at least one String or Vec<primitive> field.
    Tier2,
    /// Has nested structs, enums, Option<T>, or other unsupported types.
    Tier3,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub(crate) enum WireFieldKind {
    // Tier 1 — fixed-width primitives
    I64,
    I32,
    U32,
    U16,
    F64,
    F32,
    Bool,
    // Tier 2 — variable-length
    String,
    VecI64,
    VecF64,
    VecU8,
    VecI32,
    VecBool,
}

#[allow(dead_code)]
impl WireFieldKind {
    pub(crate) fn size(&self) -> usize {
        match self {
            Self::I64 | Self::F64 => 8,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::U16 => 2,
            Self::Bool => 1,
            Self::String
            | Self::VecI64
            | Self::VecF64
            | Self::VecU8
            | Self::VecI32
            | Self::VecBool => 1,
        }
    }

    fn element_size(&self) -> usize {
        match self {
            Self::VecI64 | Self::VecF64 => 8,
            Self::VecI32 => 4,
            Self::VecBool => 1,
            Self::VecU8 => 1,
            _ => 0,
        }
    }

    fn is_fixed(&self) -> bool {
        !matches!(
            self,
            Self::String | Self::VecI64 | Self::VecF64 | Self::VecU8 | Self::VecI32 | Self::VecBool
        )
    }
}

pub(crate) fn wire_kind_from_schema(schema: &Value) -> Option<WireFieldKind> {
    match schema.get("type").and_then(Value::as_str)? {
        "boolean" => Some(WireFieldKind::Bool),
        "integer" => match schema.get("format").and_then(Value::as_str) {
            Some("int64") => Some(WireFieldKind::I64),
            _ => Some(WireFieldKind::I32),
        },
        "number" => match schema.get("format").and_then(Value::as_str) {
            Some("double") => Some(WireFieldKind::F64),
            _ => Some(WireFieldKind::F32),
        },
        "string" => Some(WireFieldKind::String),
        "array" => {
            let items = schema.get("items")?;
            let item_type = items.get("type").and_then(Value::as_str)?;
            match item_type {
                "integer" => match items.get("format").and_then(Value::as_str) {
                    Some("int64") | None => Some(WireFieldKind::VecI64),
                    Some("int32") => Some(WireFieldKind::VecI32),
                    _ => None,
                },
                "number" => match items.get("format").and_then(Value::as_str) {
                    Some("double") | None => Some(WireFieldKind::VecF64),
                    _ => None,
                },
                "boolean" => Some(WireFieldKind::VecBool),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(crate) fn align_up(offset: usize, alignment: usize) -> usize {
    offset.div_ceil(alignment) * alignment
}

/// Check if an output schema requires Tier 3 encoding (JSON fallback).
pub(crate) fn is_output_tier3(output_schema: &Value) -> bool {
    let props = match output_schema.get("properties").and_then(Value::as_object) {
        Some(p) => p,
        None => return false,
    };
    let required: BTreeSet<String> = output_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    for (name, prop_schema) in props {
        if !required.contains(name) {
            return true;
        }
        if wire_kind_from_schema(prop_schema).is_none() {
            return true;
        }
    }
    false
}

pub(crate) fn read_wire_field(payload: &[u8], offset: usize, kind: WireFieldKind) -> Result<Value> {
    if offset + kind.size() > payload.len() {
        return Err(RustraError::invalid_args("rkyv v2: payload truncated"));
    }
    Ok(match kind {
        WireFieldKind::I64 => {
            let bytes: [u8; 8] = payload[offset..offset + 8].try_into().unwrap();
            json!(i64::from_le_bytes(bytes))
        }
        WireFieldKind::I32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(i32::from_le_bytes(bytes))
        }
        WireFieldKind::U32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(u32::from_le_bytes(bytes))
        }
        WireFieldKind::U16 => {
            let bytes: [u8; 2] = payload[offset..offset + 2].try_into().unwrap();
            json!(u16::from_le_bytes(bytes))
        }
        WireFieldKind::F64 => {
            let bytes: [u8; 8] = payload[offset..offset + 8].try_into().unwrap();
            json!(f64::from_le_bytes(bytes))
        }
        WireFieldKind::F32 => {
            let bytes: [u8; 4] = payload[offset..offset + 4].try_into().unwrap();
            json!(f32::from_le_bytes(bytes))
        }
        WireFieldKind::Bool => json!(payload[offset] != 0),
        WireFieldKind::String
        | WireFieldKind::VecI64
        | WireFieldKind::VecF64
        | WireFieldKind::VecU8
        | WireFieldKind::VecI32
        | WireFieldKind::VecBool => {
            unreachable!("variable-length fields are read inline")
        }
    })
}

// ── Helpers ───────────────────────────────────────────────────────────

fn read_vec_fixed<const N: usize>(
    payload: &[u8],
    cursor: usize,
    field_len: usize,
    decode_elem: impl Fn([u8; N]) -> Value,
) -> Result<Value> {
    if !field_len.is_multiple_of(N) {
        return Err(RustraError::invalid_args(format!(
            "rkyv v2: data length not a multiple of {N}"
        )));
    }
    let count = field_len / N;
    let mut arr = Vec::with_capacity(count);
    for i in 0..count {
        let off = cursor + i * N;
        let bytes: [u8; N] = payload[off..off + N].try_into().unwrap();
        arr.push(decode_elem(bytes));
    }
    Ok(json!(arr))
}

fn encode_vec_fixed<const N: usize>(
    buf: &mut Vec<u8>,
    val: Option<&Value>,
    _elem_size: usize,
    encode_elem: impl Fn(&Value) -> [u8; N],
) {
    let arr = val
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let data_len = arr.len() * N;
    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
    for item in arr {
        buf.extend_from_slice(&encode_elem(item));
    }
}
