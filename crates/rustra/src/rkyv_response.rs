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
