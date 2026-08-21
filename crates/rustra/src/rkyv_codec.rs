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
/// Tier 3: map 필드, 데이터를 가진 enum 등 — JSON-in-binary 폴백
/// (Option<T>/Vec<String>/Vec<Struct>/string enum 은 2026-08-20 JS 코덱 확장으로 지원)
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

/// Typed payload carried inside an rkyv V2 error frame. Postcard-serialised so
/// the JS codec can decode `{ code, message }` with the same postcard helpers
/// used for command I/O — the structured `code` (e.g. `command.not_found`,
/// `math.divide_by_zero`) survives the wire instead of being flattened into a
/// display string.
#[derive(serde::Serialize)]
struct RustraErrorWire<'a> {
    code: &'a str,
    message: &'a str,
}

/// Encodes an rkyv V2 error response.
///
/// Wire format:
/// ```text
/// [ok: u8 @0 = 0][pad 7B][err_len: u16 @8 LE][postcard({code, message}) @10...]
/// ```
///
/// The envelope is unchanged from the legacy string-error format; only the
/// `err_bytes` content changes — it is now a postcard-serialised
/// `{ code: String, message: String }` so the receiving side can reconstruct a
/// typed `RustraCommandError(code, message)` rather than a plain `Error`.
pub fn encode_rkyv_v2_error(error: &RustraError) -> Vec<u8> {
    let message = error.message();
    let wire = RustraErrorWire {
        code: error.code(),
        message,
    };
    let mut body = postcard::to_allocvec(&wire).unwrap_or_default();
    // u16::MAX 잘림 표시 — 대형 validation 에러가 경고 없이 유실되면 디버깅이
    // 곤란해진다. 잘림이 예상되는 경우 애초에 접두 512바이트 + 마커로 재구성해
    // 와이어 프레임 안에서 잘림이 표시되게 한다(정상 경로는 그대로 둔다).
    if body.len() > u16::MAX as usize {
        let truncated = format!("{}…(truncated)", &message[..message.len().min(512)]);
        let wire = RustraErrorWire {
            code: error.code(),
            message: truncated.as_str(),
        };
        body = postcard::to_allocvec(&wire).unwrap_or_default();
    }
    let body_len = body.len().min(u16::MAX as usize) as u16;
    let mut buf = vec![0u8; 10 + body_len as usize];
    buf[0] = 0; // ok = false
    buf[8..10].copy_from_slice(&body_len.to_le_bytes());
    buf[10..10 + body_len as usize].copy_from_slice(&body[..body_len as usize]);
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

// ── (Tier 3 정합) JS postcard 코덱 지원 판정 미러 ─────────────
//
// @rustra/cli 의 classifyPostcardField(generate.ts)와 동일한 타입 집합을
// Rust 쪽에서 판정한다. JS 코드젠은 미지원 필드를 가진 명령을 rkyv-registry
// 에서 제외하고, 엔진은 그 명령을 Tier 3(JSON-in-binary) 로 라우팅한다.
// Rust 도 같은 판정으로 typed postcard fast-path 를 끄면 양쪽 와이어가
// 일치한다. 집합이 어긋나면 JS postcard ↔ Rust JSON 프레임 불일치가 되므로,
// JS 쪽 지원 범위를 확장할 때 이 함수를 함께 갱신해야 한다 (codegen 마감 조항).

/// 스키마(객체)의 모든 프로퍼티가 JS postcard 코덱 지원 타입인지 판정한다.
/// 중첩 $ref 정의는 재귀 순회한다. definitions 없는 레거시 호출부용 — 신규
/// 코드는 definitions 를 따라가는 [`js_postcard_codec_supported_with_defs`] 를
/// 쓴다($ref 가 미지원 타입을 가리키는 경우까지 검증).
#[allow(dead_code)]
pub(crate) fn js_postcard_codec_supported(schema: &Value) -> bool {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return true; // properties 없음(unit 등) — 항상 지원
    };
    props.values().all(|p| js_field_supported(p, 0))
}

/// definitions 를 받는 확장 판정 — `$ref` 를 실제 정의 스키마까지 따라간다.
///
/// 과거 판정은 `$ref` 를 무조건 지원(struct)으로 취급했다(주석이 "단순화"라고
/// 자백). `$ref` 가 map/oneOf 같은 미지원 타입을 가리키면 Rust 는 typed
/// fast-path 를 켜고 JS 는 다른 인코딩을 써서 런타임 디코딩이 깨진다 — 여기서
/// 정의를 따라가 재검증해 그 조합을 Tier 3 로 밀어낸다.
pub(crate) fn js_postcard_codec_supported_with_defs(schema: &Value, definitions: &Value) -> bool {
    let defs = definitions.as_object();
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return true;
    };
    props
        .values()
        .all(|p| js_field_supported_with_defs(p, defs, 0))
}

fn resolve_ref<'a>(
    schema: &'a Value,
    defs: Option<&'a serde_json::Map<String, Value>>,
) -> &'a Value {
    let Some(name) = schema.get("$ref").and_then(Value::as_str) else {
        return schema;
    };
    // JSON Schema $ref 형태 "#/definitions/Name"(또는 $defs) 에서 마지막 세그먼트로
    // 조회한다. 못 찾으면 원본을 그대로 반환 — 판정은 이어서 안전하게 실패한다.
    let key = name.rsplit('/').next().unwrap_or(name);
    defs.and_then(|d| d.get(key)).unwrap_or(schema)
}

fn js_field_supported_with_defs(
    schema: &Value,
    defs: Option<&serde_json::Map<String, Value>>,
    depth: u8,
) -> bool {
    if depth > 8 {
        return false; // 과도한 중첩(순환 $ref 포함) — 안전하게 미지원 취급
    }
    // $ref → 정의 스키마를 따라가 판정한다. 정의를 못 찾으면 원본 스키마로
    // 폴백해 아래 규칙이 그대로 적용된다(과거 동작과 동일하게 안전 실패).
    if schema.get("$ref").is_some() {
        let resolved = resolve_ref(schema, defs);
        if !std::ptr::eq(resolved, schema) {
            return js_field_supported_with_defs(resolved, defs, depth + 1);
        }
        return true; // 정의 미발견 — 기존 "struct 로 취급" 동작 유지
    }
    // anyOf 의 [{$ref}, null] 형태(Option<Struct>)도 정의를 따라간다.
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        let has_null = any_of
            .iter()
            .any(|s| s.get("type") == Some(&Value::String("null".into())));
        let ref_schemas: Vec<&Value> = any_of.iter().filter(|s| s.get("$ref").is_some()).collect();
        if has_null && ref_schemas.len() == 1 && any_of.len() == 2 {
            let resolved = resolve_ref(ref_schemas[0], defs);
            if !std::ptr::eq(resolved, ref_schemas[0]) {
                return js_field_supported_with_defs(resolved, defs, depth + 1);
            }
            return true;
        }
        return false;
    }
    // 배열 items 의 $ref(Vec<Struct>)도 정의를 따라간다.
    if schema.get("type").and_then(Value::as_str) == Some("array") {
        if let Some(items) = schema.get("items") {
            if items.get("$ref").is_some() {
                let resolved = resolve_ref(items, defs);
                if !std::ptr::eq(resolved, items) {
                    return js_field_supported_with_defs(resolved, defs, depth + 1);
                }
                return true;
            }
            return matches!(
                items.get("type").and_then(Value::as_str),
                Some("integer") | Some("number") | Some("boolean") | Some("string")
            );
        }
        return false;
    }
    // object(struct) — 프로퍼티 전체를 재귀 판정한다. $ref 해결로 도달한
    // 중첩 구조체가 여기서 false 폴백에 걸려 Tier 3 로 잘못 밀려지는 일을 막는다.
    // additionalProperties 가 있으면 map 이므로 미지원.
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        if schema.get("additionalProperties").is_some() {
            return false;
        }
        let Some(props) = schema.get("properties").and_then(Value::as_object) else {
            return true; // 빈 객체
        };
        return props
            .values()
            .all(|p| js_field_supported_with_defs(p, defs, depth + 1));
    }
    js_field_supported(schema, depth)
}

fn js_field_supported(schema: &Value, depth: u8) -> bool {
    if depth > 8 {
        return false; // 과도한 중첩 — 안전하게 미지원 취급
    }
    // string-only enum → 지원 (variant index varint)
    if schema.get("type").and_then(Value::as_str) == Some("string") {
        return true;
    }
    // Option<T> — type: ["T","null"] 또는 anyOf: [T, null]
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        let non_null: Vec<&str> = types
            .iter()
            .filter_map(Value::as_str)
            .filter(|t| *t != "null")
            .collect();
        if non_null.len() == 1 {
            let inner_type = non_null[0];
            // JS option_* kind 지원 집합: zigzag/f64/f32/bool/string/struct
            return matches!(inner_type, "integer" | "number" | "boolean" | "string");
        }
        return false;
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        // [{$ref}, {type:null}] 형태의 Option<Struct> → 지원
        let has_null = any_of
            .iter()
            .any(|s| s.get("type") == Some(&Value::String("null".into())));
        let refs = any_of.iter().filter(|s| s.get("$ref").is_some()).count();
        if has_null && refs == 1 && any_of.len() == 2 {
            return true;
        }
        return false;
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("boolean") | Some("integer") | Some("number") | Some("string") => true,
        Some("array") => {
            let Some(items) = schema.get("items") else {
                return false;
            };
            if items.get("$ref").is_some() {
                return true; // Vec<Struct> → vec_struct
            }
            matches!(
                items.get("type").and_then(Value::as_str),
                Some("integer") | Some("number") | Some("boolean") | Some("string")
            )
        }
        _ => false, // object(map), oneOf 등 — JS 코덱 미지원
    }
}
