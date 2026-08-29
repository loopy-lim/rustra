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
