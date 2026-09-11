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

/// 와이어에서 받은 `{ code, message }` 본문 — 인코더 측 [`RustraErrorWire`] 의
/// 소유(de) 버전. postcard 는 필드 선언 순서로 직렬화하므로 code → message
/// 순서를 그대로 유지해야 한다.
#[derive(serde::Deserialize)]
struct RustraErrorWireOwned {
    code: String,
    message: String,
}

/// 응답 프레임을 검증해 성공 본문 / 에러 {code, message} 로 분리한 결과.
enum SplitResponse<'a> {
    /// 성공 프레임 — @8 이후 postcard 본문 슬라이스.
    Success(&'a [u8]),
    /// 에러 프레임 — 와이어에서 재구성한 동적 (code, message).
    Error { code: String, message: String },
}

/// 응답 프레임을 검증해 성공 본문 / 에러 {code, message} 로 분리한다(공용 헬퍼).
///
/// 프레임 자체의 형식 결함(길이 부족, ok 바이트 초범위, err_len 경계 이탈,
/// postcard 디코딩 실패)은 `invalid_args` 로 거절한다 — 기존 와이어 검증 메시지
/// 관례(`rkyv v2: …` 접두사)를 유지.
fn split_rkyv_v2_response(frame: &[u8]) -> crate::Result<SplitResponse<'_>> {
    if frame.len() < 8 {
        return Err(RustraError::invalid_args(
            "rkyv v2: response frame too short",
        ));
    }
    match frame[0] {
        1 => Ok(SplitResponse::Success(&frame[8..])),
        0 => {
            if frame.len() < 10 {
                return Err(RustraError::invalid_args(
                    "rkyv v2: error frame too short for err_len",
                ));
            }
            // err_len ≤ u16::MAX 이므로 10 + err_len 은 usize 에서 절대 넘치지 않는다.
            let err_len = u16::from_le_bytes([frame[8], frame[9]]) as usize;
            if frame.len() < 10 + err_len {
                return Err(RustraError::invalid_args("rkyv v2: error frame body truncated"));
            }
            let wire: RustraErrorWireOwned = postcard::from_bytes(&frame[10..10 + err_len])
                .map_err(|error| {
                    RustraError::invalid_args(format!(
                        "rkyv v2: error frame body decode failed: {error}"
                    ))
                })?;
            Ok(SplitResponse::Error {
                code: wire.code,
                message: wire.message,
            })
        }
        other => Err(RustraError::invalid_args(format!(
            "rkyv v2: unknown ok byte {other}"
        ))),
    }
}

/// rkyv V2 응답 프레임을 검증해 postcard 본문 슬라이스로 분리합니다.
///
/// 성공 프레임(`[ok:1][7B reserved][postcard(Output) @8]`)이면 @8 이후 본문을
/// 그대로 빌려 반환합니다 — 호출자는 [`postcard::from_bytes`] 로 출력 타입을
/// 복원합니다. 에러 프레임은 [`RustraError::internal`] 로 반환합니다. 한계:
/// [`RustraError`] 의 `code` 는 `&'static str` 이라 와이어의 동적 코드를 무할당으로
/// 재구성할 수 없으므로, 코드를 메시지에 `code: message` 형태로 통합해 전달합니다
/// (호출마다 누수하는 대안은 의도적으로 채택하지 않았습니다). 동적 코드가 필요한
/// 파서는 구조화 변형 [`decode_rkyv_v2_error_parts`] 를 사용하세요. 형식 결함
/// 프레임은 `command.invalid_args` 로 거절합니다.
///
/// [`postcard::from_bytes`]: https://docs.rs/postcard/latest/postcard/
pub fn decode_rkyv_v2_response(frame: &[u8]) -> crate::Result<&[u8]> {
    match split_rkyv_v2_response(frame)? {
        SplitResponse::Success(body) => Ok(body),
        SplitResponse::Error { code, message } => {
            Err(RustraError::internal(format!("{code}: {message}")))
        }
    }
}

/// [`decode_rkyv_v2_response`] 의 구조화 변형 — 에러 프레임의 `(code, message)` 를
/// 소유 `(String, String)` 으로 돌려줍니다. 에러 프레임 한정 디코더이며, 성공
/// 프레임을 받으면 `command.invalid_args` 에러입니다.
pub fn decode_rkyv_v2_error_parts(frame: &[u8]) -> crate::Result<(String, String)> {
    match split_rkyv_v2_response(frame)? {
        SplitResponse::Success(_) => Err(RustraError::invalid_args(
            "rkyv v2: success frame is not an error frame",
        )),
        SplitResponse::Error { code, message } => Ok((code, message)),
    }
}
