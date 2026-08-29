fn build_rkyv_v2_handler<I, O, F>(
    input_schema: &Value,
    output_schema: &Value,
    definitions: &Value,
    handler: &Arc<F>,
    js_codec_supported: bool,
    complex_codec_supported: bool,
    force_tier3: bool,
) -> Option<BinHandler>
where
    I: DeserializeOwned + 'static,
    O: Serialize + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    // Generate fast postcard-based binary handler that bypasses JSON Value.
    // force_tier3 인 경우 postcard fast-path 를 끄고 Tier 3 JSON fallback 로 보낸다.
    let rkyv_v2_handler: Option<BinHandler> =
        if force_tier3 || (!js_codec_supported && !complex_codec_supported) {
            None
        } else if js_codec_supported {
            let handler_bin = handler.clone();
            Some(Arc::new(move |payload: &[u8]| {
                if payload.len() < 2 {
                    return Err(RustraError::invalid_args("rkyv v2: payload too short"));
                }
                let input: I = postcard::from_bytes(&payload[2..])
                    .map_err(|e| RustraError::invalid_args(format!("postcard decode: {e}")))?;
                let output = handler_bin(input)?;
                // 응답 body 임시 Vec + frame Vec의 2회 할당/복사를 피한다. 정확한
                // postcard 크기로 최종 frame을 한 번만 할당하고 그 뒤에 바로
                // 직렬화한다. 병렬 JSI 호출에서 allocator lock 경합도 절반이 된다.
                let encoded_len = postcard::experimental::serialized_size(&output)
                    .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))?;
                let mut buf = Vec::with_capacity(8 + encoded_len);
                buf.resize(8, 0);
                buf[0] = 1; // ok = true
                postcard::to_extend(&output, buf)
                    .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))
            }))
        } else {
            // complex binary 라우트 — 스키마 IR 을 빌드 시점에 1회 컴파일해 캡처
            // 한다(트랙 A). 호출당 `resolved_schema` 클론/`variants` 정렬이 없고
            // 컴파일 결과(미지원 스키마 에러 포함)가 호출 시점에 재방출된다.
            let input_codec = CompiledComplex::new(input_schema, definitions);
            let output_codec = CompiledComplex::new(output_schema, definitions);
            let handler_complex = handler.clone();
            Some(Arc::new(move |payload: &[u8]| {
                if payload.len() < 2 {
                    return Err(RustraError::invalid_args("rkyv v2: payload too short"));
                }
                let limits = ComplexCodecLimits {
                    max_payload_bytes: crate::limits::max_payload_bytes(),
                    ..ComplexCodecLimits::DEFAULT
                };
                let input_value = input_codec.decode(&payload[2..], limits)?;
                let input: I = serde_json::from_value(input_value)
                    .map_err(|e| RustraError::invalid_args(format!("complex decode: {e}")))?;
                let output = handler_complex(input)?;
                let output_value = serde_json::to_value(output)
                    .map_err(|e| RustraError::internal(format!("complex encode: {e}")))?;
                let body = output_codec.encode(&output_value, limits)?;
                let response_len = 8usize.saturating_add(body.len());
                if response_len > limits.max_payload_bytes {
                    return Err(RustraError::payload_too_large(
                        response_len,
                        limits.max_payload_bytes,
                    ));
                }
                let mut response = Vec::with_capacity(response_len);
                response.resize(8, 0);
                response[0] = 1;
                response.extend_from_slice(&body);
                Ok(response)
            }))
        };

    rkyv_v2_handler
}
