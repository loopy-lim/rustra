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

// U32/U16/VecU8 은 read/write arms(frame_decode/frame_response)가 소비하지만
// wire_kind_from_schema 가 아직 생성하지 않는다 — 판정이 확장되면 소멸한다.
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

pub(crate) fn required_names(schema: &Value) -> BTreeSet<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// `payload[offset..offset + N]` 를 고정폭 바이트 배열로 꺼낸다. 호출자가 길이
/// 가드를 두는 것이 계약이지만(read_wire_field / frame 디코드 경로), unwrap 대신
/// 명시적 오류로 신뢰 경계를 닫는다 — 와이어 불변이 깨져도 패닉하지 않는다.
pub(crate) fn read_fixed_le<const N: usize>(payload: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset + N;
    let bytes = payload
        .get(offset..end)
        .and_then(|slice| <[u8; N]>::try_from(slice).ok());
    bytes.ok_or_else(|| RustraError::invalid_args("frame: payload truncated"))
}

pub(crate) fn read_wire_field(payload: &[u8], offset: usize, kind: WireFieldKind) -> Result<Value> {
    if offset + kind.size() > payload.len() {
        return Err(RustraError::invalid_args("frame: payload truncated"));
    }
    Ok(match kind {
        WireFieldKind::I64 => {
            let bytes = read_fixed_le::<8>(payload, offset)?;
            json!(i64::from_le_bytes(bytes))
        }
        WireFieldKind::I32 => {
            let bytes = read_fixed_le::<4>(payload, offset)?;
            json!(i32::from_le_bytes(bytes))
        }
        WireFieldKind::U32 => {
            let bytes = read_fixed_le::<4>(payload, offset)?;
            json!(u32::from_le_bytes(bytes))
        }
        WireFieldKind::U16 => {
            let bytes = read_fixed_le::<2>(payload, offset)?;
            json!(u16::from_le_bytes(bytes))
        }
        WireFieldKind::F64 => {
            let bytes = read_fixed_le::<8>(payload, offset)?;
            json!(f64::from_le_bytes(bytes))
        }
        WireFieldKind::F32 => {
            let bytes = read_fixed_le::<4>(payload, offset)?;
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
