/// 입력/출력 스키마에서 raw 직결 가능성을 판정하고 핸들러를 조립한다.
/// 슬롯 ↔ 타입 변환은 JSON Value 경유로 수행한다(I/O 타입이 제네릭이라
/// 개별 스칼라 타입에 특화할 수 없기 때문) — postcard 왕복 대비 Value 1회
/// 변환만 남는다. 스키마 필드명으로 객체를 조립하므로 선언순 계약을 그대로
/// 따른다.
fn build_raw_handler<I, O, F>(
    input_schema: &Value,
    output_schema: &Value,
    handler: &Arc<F>,
) -> (Option<RawHandler>, Vec<crate::rkyv_codec::RawFieldKind>)
where
    I: DeserializeOwned + 'static,
    O: Serialize + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    use crate::rkyv_codec::RawFieldKind;

    // 입력: object 프로퍼티 1..3개 전부 스칼라.
    let Some(props) = input_schema.get("properties").and_then(Value::as_object) else {
        return (None, Vec::new());
    };
    if props.is_empty() || props.len() > 3 {
        return (None, Vec::new());
    }
    let mut input_kinds = Vec::with_capacity(props.len());
    let mut field_names = Vec::with_capacity(props.len());
    for (name, schema) in props {
        let Some(kind_str) = schema.get("type").and_then(Value::as_str) else {
            return (None, Vec::new());
        };
        // integer 형식 정보로 zigzag/uvar 를 가린다 — postcard 는 signed 는
        // zigzag, unsigned 는 plain varint. format 미지정 signed 정수는 zigzag.
        let kind = match kind_str {
            "integer" => {
                let format = schema.get("format").and_then(Value::as_str).unwrap_or("");
                match format {
                    "uint8" | "uint16" | "uint32" | "uint64" => RawFieldKind::Uvar,
                    _ => RawFieldKind::Zigzag,
                }
            }
            "number" => RawFieldKind::F64,
            "boolean" => RawFieldKind::Bool,
            _ => return (None, Vec::new()),
        };
        // f32 판별: number + format "float"(schemars 관례).
        if kind == RawFieldKind::F64
            && schema.get("format").and_then(Value::as_str) == Some("float")
        {
            input_kinds.push(RawFieldKind::F32);
        } else {
            input_kinds.push(kind);
        }
        field_names.push(name.clone());
    }

    // 출력: 단일 스칼라 프로퍼티(또는 빈 객체=unit).
    let out_props = output_schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let output_kind = if out_props.is_empty() {
        None
    } else if out_props.len() == 1 {
        let (_name, schema) = out_props.iter().next().expect("len==1");
        let Some(kind_str) = schema.get("type").and_then(Value::as_str) else {
            return (None, Vec::new());
        };
        let kind = match kind_str {
            "integer" => {
                let format = schema.get("format").and_then(Value::as_str).unwrap_or("");
                match format {
                    "uint8" | "uint16" | "uint32" | "uint64" => RawFieldKind::Uvar,
                    _ => RawFieldKind::Zigzag,
                }
            }
            "number" => RawFieldKind::F64,
            "boolean" => RawFieldKind::Bool,
            _ => return (None, Vec::new()),
        };
        Some(kind)
    } else {
        return (None, Vec::new());
    };

    // postcard 출력은 필드명을 와이어에 싣지 않는다(선언순 값 나열) —
    // 출력 필드 이름은 디코딩에 불필요하다.
    let kinds_snapshot = input_kinds.clone();
    let output_kind_snapshot = output_kind;
    let handler = Arc::clone(handler);
    // postcard 입력 바디 프리픽스 — 각 필드의 와이어 인코딩은 슬롯 값에서
    // 결정론적으로 조립된다(선언순). Vec 할당을 피하기 위해 고정 32B 버퍼:
    // 스칼라 3개면 최대 8+8+10(과잉 여유)에 충분하다. 부족(이론상 i64
    // varint 10B×3)해도 안전하다 — 초과분은 없다(3×10=30<32).
    let raw: RawHandler = Arc::new(move |slots: &[u64]| {
        if slots.len() != kinds_snapshot.len() {
            return Err(RustraError::invalid_args(format!(
                "raw invoke: expected {} slots, got {}",
                kinds_snapshot.len(),
                slots.len()
            )));
        }
        // 1) 슬롯 → postcard 입력 바디(필드 와이어와 동일한 인코딩).
        let mut body = [0u8; 32];
        let mut w = 0usize;
        let push_varint = |buf: &mut [u8; 32], w: &mut usize, mut v: u64| {
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    buf[*w] = b;
                    *w += 1;
                    break;
                }
                buf[*w] = b | 0x80;
                *w += 1;
            }
        };
        for (i, kind) in kinds_snapshot.iter().enumerate() {
            match kind {
                RawFieldKind::Zigzag => {
                    let v = slots[i] as i64;
                    let zig = ((v << 1) ^ (v >> 63)) as u64;
                    push_varint(&mut body, &mut w, zig);
                }
                RawFieldKind::Uvar => push_varint(&mut body, &mut w, slots[i]),
                RawFieldKind::F64 => {
                    body[w..w + 8].copy_from_slice(&slots[i].to_le_bytes());
                    w += 8;
                }
                RawFieldKind::F32 => {
                    // f32 정밀도로 반올림한 뒤 4바이트 LE — postcard f32 와이어.
                    let f = crate::rkyv_codec::f64_from_u64(slots[i]) as f32;
                    body[w..w + 4].copy_from_slice(&f.to_le_bytes());
                    w += 4;
                }
                RawFieldKind::Bool => {
                    body[w] = u8::from(slots[i] != 0);
                    w += 1;
                }
            }
        }
        // 2) postcard 디코딩 — 기존 rkyv V2 경로와 동일한 저비용 디코더.
        let input: I = postcard::from_bytes(&body[..w])
            .map_err(|e| RustraError::invalid_args(format!("raw invoke decode: {e}")))?;
        let output = handler(input)?;
        // 3) 출력 — 단일 스칼라 필드를 postcard 로 1회 직렬화해 슬롯으로 복원.
        //    Value 경유 없이 serialized_size + to_slice 로 프리픽스 버퍼에.
        let Some(out_kind) = output_kind_snapshot else {
            return Ok(0); // unit 출력
        };
        let mut out_buf = [0u8; 16];
        let encoded = postcard::to_slice(&output, &mut out_buf)
            .map_err(|e| RustraError::internal(format!("raw invoke encode: {e}")))?;
        if encoded.is_empty() {
            return Err(RustraError::internal("raw invoke: empty output wire"));
        }
        let slot = decode_raw_output(encoded, out_kind)?;
        Ok(slot)
    });
    (Some(raw), input_kinds)
}
