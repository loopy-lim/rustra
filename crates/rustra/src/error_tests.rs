use super::*;

#[test]
fn cancelled_error_is_retryable_with_stable_code() {
    let e = RustraError::cancelled("aborted by AbortSignal");
    assert_eq!(e.code(), "cancelled");
    assert_eq!(e.message(), "aborted by AbortSignal");
    assert!(
        e.is_retryable(),
        "cancelled means the caller gave up on this attempt, not the operation"
    );
}

#[test]
fn payload_too_large_is_non_retryable_with_bytes_context() {
    let e = RustraError::payload_too_large(1_048_577, 1_048_576);
    assert_eq!(e.code(), "payload.too_large");
    // 메시지에 실제/한도 바이트가 모두 실린다 — JS 사전 검사 에러와 동일 형태.
    assert_eq!(e.message(), "payload 1048577B exceeds max payload 1048576B");
    assert!(!e.is_retryable(), "deterministic client condition");
    // Display 는 "code: message" — JS parseRustraErrorString 가 코드 토큰을
    // 복원하는 형태.
    assert_eq!(
        e.to_string(),
        "payload.too_large: payload 1048577B exceeds max payload 1048576B"
    );
}
