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
