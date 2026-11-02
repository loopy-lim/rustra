// ── Helpers ───────────────────────────────────────────────────────────

fn read_vec_fixed<const N: usize>(
    payload: &[u8],
    cursor: usize,
    field_len: usize,
    decode_elem: impl Fn([u8; N]) -> Value,
) -> Result<Value> {
    if !field_len.is_multiple_of(N) {
        return Err(RustraError::invalid_args(format!(
            "frame: data length not a multiple of {N}"
        )));
    }
    let count = field_len / N;
    let mut arr = Vec::with_capacity(count);
    for i in 0..count {
        let off = cursor + i * N;
        // 호출자의 cursor + field_len <= payload.len() 가드와 multiple-of 검사가
        // 범위를 보증하지만, unwrap 대신 명시적 오류로 신뢰 경계를 유지한다.
        let bytes: [u8; N] = payload
            .get(off..off + N)
            .and_then(|slice| <[u8; N]>::try_from(slice).ok())
            .ok_or_else(|| {
                RustraError::invalid_args("frame: payload truncated at var-field data")
            })?;
        arr.push(decode_elem(bytes));
    }
    Ok(json!(arr))
}

fn encode_vec_fixed<const N: usize>(
    buf: &mut Vec<u8>,
    val: Option<&Value>,
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
