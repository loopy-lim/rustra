fn build_rkyv_v2_into_handler<I, O, F>(
    input_schema: &Value,
    output_schema: &Value,
    definitions: &Value,
    handler: &Arc<F>,
    js_codec_supported: bool,
    complex_codec_supported: bool,
    force_tier3: bool,
) -> Option<BinIntoHandler>
where
    I: DeserializeOwned + 'static,
    O: Serialize + 'static,
    F: Fn(I) -> crate::Result<O> + Send + Sync + 'static,
{
    // caller-buffer into-handler — postcard 코덱 명령에 더해 complex binary
    // 라우트 명령도 생성한다. complex 출력은 bounded writer로 caller 버퍼에
    // 직접 기록되고, 버퍼 부족은 기존 `DirectResponse::Buffered` 폴백(할당 경로)
    // 으로 흘러간다. 와이어는 `rkyv_v2_handler` complex 분기와 동일한 바이트다.
    // force_tier3 명령은 애초에 binary fast-path 가 없으므로 여전히 None.
    let rkyv_v2_into_handler: Option<BinIntoHandler> = if force_tier3
        || (!js_codec_supported && !complex_codec_supported)
    {
        None
    } else if js_codec_supported {
        let handler_into = handler.clone();
        Some(Arc::new(move |payload: &[u8], target: &mut [u8]| {
            if payload.len() < 2 {
                return Err(RustraError::invalid_args("rkyv v2: payload too short"));
            }
            let input: I = postcard::from_bytes(&payload[2..])
                .map_err(|e| RustraError::invalid_args(format!("postcard decode: {e}")))?;
            let output = handler_into(input)?;

            // Try-first: caller 버퍼에 바로 직렬화를 시도한다. 대부분의 응답은
            // 여기서 한 번의 패스로 끝난다 — 이전의 serialized_size 선행 패스
            // (크기 계산 + 실직렬화 = 2패스)를 없앤다. postcard의 Slice flavor
            // 는 부족하면 SerializeBufferFull 로 실패하고 &output 은 소모되지
            // 않으므로(1.1.3 flavors.rs — 부분 기록은 있으나 폴백이 전체 재기록)
            // 폴백에서 to_extend 로 온전히 다시 쓴다.
            if target.len() > 8 {
                target[..8].fill(0);
                target[0] = 1;
                match postcard::to_slice(&output, &mut target[8..]) {
                    Ok(written) => {
                        return Ok(DirectResponse::Written(8 + written.len()));
                    }
                    Err(postcard::Error::SerializeBufferFull) => {}
                    Err(e) => return Err(RustraError::internal(format!("postcard encode: {e}"))),
                }
            }

            // 큰 응답은 현재 output을 정확히 한 번 직렬화해 캐시에 넘긴다.
            // 핸들러를 재실행하지 않으므로 비멱등 command도 안전하다.
            let mut response = Vec::with_capacity(64);
            response.resize(8, 0);
            response[0] = 1;
            let response = postcard::to_extend(&output, response)
                .map_err(|e| RustraError::internal(format!("postcard encode: {e}")))?;
            Ok(DirectResponse::Buffered(response))
        }))
    } else {
        // complex binary 라우트 — 입력 디코드/출력 인코딩은 rkyv_v2_handler 의
        // complex 분기와 같은 스키마 같은 와이어. 스키마 IR 을 빌드 시점에 1회
        // 컴파일해 캡처한다(트랙 A). 출력만 bounded writer로 caller 버퍼에
        // 직접 기록한다.
        let input_codec = CompiledComplex::new(input_schema, definitions);
        let output_codec = CompiledComplex::new(output_schema, definitions);
        let handler_into = handler.clone();
        Some(Arc::new(move |payload: &[u8], target: &mut [u8]| {
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
            let output = handler_into(input)?;
            let output_value = serde_json::to_value(output)
                .map_err(|e| RustraError::internal(format!("complex encode: {e}")))?;

            // Try-first: 8B 응답 header를 깔고 body를 caller 버퍼에 직접 인코딩.
            // 실패(버퍼 overflow, 인코딩 에러 모두)면 아래 heap 경로가 같은 값을
            // 다시 인코딩해 Buffered 폴백 또는 동일 에러를 반환한다 — 인코딩이
            // 결정론이므로 결과가 같고, 핸들러는 재실행되지 않는다(비멱등 안전).
            if target.len() > 8 {
                target[..8].fill(0);
                target[0] = 1;
                if let Ok(body_len) =
                    output_codec.encode_into(&output_value, &mut target[8..], limits)
                {
                    let response_len = 8 + body_len;
                    if response_len <= limits.max_payload_bytes {
                        return Ok(DirectResponse::Written(response_len));
                    }
                    // 헤더 포함 총량이 한도를 넘으면 heap 경로의
                    // payload_too_large 검사가 malloc 경로와 동일한 에러를 만든다.
                }
            }

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
            Ok(DirectResponse::Buffered(response))
        }))
    };

    rkyv_v2_into_handler
}
