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
