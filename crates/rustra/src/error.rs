//! rustra 명령 실행 중 발생할 수 있는 에러 타입입니다.

use std::fmt;

/// rustra 작업의 결과 타입입니다.
///
/// [`RustraError`]를 에러로 사용하는 [`std::result::Result`]의 별칭입니다.
pub type Result<T> = std::result::Result<T, RustraError>;

/// rustra 명령 실행 중 발생할 수 있는 에러입니다.
///
/// 모든 에러는 `code`와 `message` 필드를 가지며, TypeScript 측에서도
/// 동일한 구조의 [`RustraError`] 타입으로 전달됩니다.
///
/// # 에러 코드 분류
///
/// | 코드 | 팩토리 메서드 | 의미 |
/// |------|-------------|------|
/// | `command.not_found` | [`command_not_found`] | 등록되지 않은 명령 호출 |
/// | `command.invalid_args` | [`invalid_args`] | 입력 인자 역직렬화 실패 |
/// | `capability.denied` | [`capability_denied`] | 필요 capability 미부여 (deny-by-default) |
/// | `payload.too_large` | [`payload_too_large`] | 페이로드가 동적 크기 한도 초과 |
/// | `internal` | [`internal`] | 내부 오류 (직렬화, I/O 등) |
/// | `cancelled` | [`cancelled`] | 호출 취소 (AbortSignal 등) |
/// | (커스텀) | [`custom`] | 사용자 정의 에러 |
///
/// [`command_not_found`]: RustraError::command_not_found
/// [`invalid_args`]: RustraError::invalid_args
/// [`capability_denied`]: RustraError::capability_denied
/// [`payload_too_large`]: RustraError::payload_too_large
/// [`internal`]: RustraError::internal
/// [`cancelled`]: RustraError::cancelled
/// [`custom`]: RustraError::custom
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RustraError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "is_false")]
    retryable: bool,
}

fn is_false(v: &bool) -> bool {
    !v
}

impl RustraError {
    /// 등록되지 않은 명령을 호출했을 때의 에러를 생성합니다.
    pub fn command_not_found(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            code: "command.not_found",
            message: format!("command not found: {name}"),
            retryable: false,
        }
    }

    /// 입력 인자의 역직렬화에 실패했을 때의 에러를 생성합니다.
    pub fn invalid_args(error: impl fmt::Display) -> Self {
        Self {
            code: "command.invalid_args",
            message: error.to_string(),
            retryable: false,
        }
    }

    /// 내부 오류 (직렬화 실패, I/O 오류 등) 에러를 생성합니다.
    pub fn internal(error: impl fmt::Display) -> Self {
        Self {
            code: "internal",
            message: error.to_string(),
            retryable: false,
        }
    }

    /// 사용자 정의 에러 코드와 메시지로 에러를 생성합니다.
    ///
    /// `code`는 `&'static str`이어야 하며, 도메인 점 표기법을 권장합니다.
    pub fn custom(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }

    /// 명령이 요구하는 capability 가 부여되지 않았을 때의 에러.
    ///
    /// Runtime Authority 는 deny-by-default 이다 — capability 가 demanding 명령은
    /// 해당 capability 가 명시적으로 부여(`Package::grant_capability`)되기 전까지
    /// 실행되지 않는다. 핸들러는 아예 호출되지 않는다. Code: `capability.denied`.
    pub fn capability_denied(detail: impl fmt::Display) -> Self {
        Self {
            code: "capability.denied",
            message: detail.to_string(),
            retryable: false,
        }
    }

    /// 페이로드가 동적 크기 한도(`rustra_ffi_set_max_payload`, 기본 1 MiB)를
    /// 초과함. JS 사전 검사(`maxPayloadBytes` 엔진 옵션)와 동일한 코드를 쓴다 —
    /// 경로(typed/JS 코덱/FFI)와 무관하게 같은 원인은 같은 코드로 돌아온다.
    /// Code: `payload.too_large`. Non-retryable (결정론적 클라이언트 조건).
    pub fn payload_too_large(len: usize, limit: usize) -> Self {
        Self {
            code: "payload.too_large",
            message: format!("payload {len}B exceeds max payload {limit}B"),
            retryable: false,
        }
    }

    /// 에러 코드를 반환합니다.
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// 에러 메시지를 반환합니다.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Transport/network error. Code: `transport.error`. Retryable.
    pub fn transport(error: impl fmt::Display) -> Self {
        Self {
            code: "transport.error",
            message: error.to_string(),
            retryable: true,
        }
    }

    /// Timeout error. Code: `transport.timeout`. Retryable.
    pub fn timeout(error: impl fmt::Display) -> Self {
        Self {
            code: "transport.timeout",
            message: error.to_string(),
            retryable: true,
        }
    }

    /// 호출이 취소됨 — AbortSignal/cancel 로 호출자가 포기한 경우.
    /// Code: `cancelled`. Retryable (재시도 시 정상 동작 가능).
    pub fn cancelled(detail: impl fmt::Display) -> Self {
        Self {
            code: "cancelled",
            message: detail.to_string(),
            retryable: true,
        }
    }

    /// Builder-style method to mark any error as retryable.
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

impl fmt::Display for RustraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RustraError {}

impl From<std::io::Error> for RustraError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
    }
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod cancelled_tests;
