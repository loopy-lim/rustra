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
