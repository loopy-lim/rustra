export type RustraError = {
  readonly code: string;
  readonly message: string;
  /** Rust `RustraError::retryable` — `transport.error`/`transport.timeout` 등에서 true */
  readonly retryable?: boolean;
};

export class RustraCommandError extends Error {
  readonly code: string;
  /** 재시도 가능한 에러인지 — Rust `RustraError::is_retryable` 와이어 값을 그대로 노출 */
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RustraCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Rust `RustraError::Display` 포맷(`"{code}: {message}"`)의 평탄화된 문자열을
 * [`RustraCommandError`]로 파싱한다. JSON fallback 경로(네이티브 모듈)에서 사용 —
 * rkyv V2 경로(Node/Tauri)는 구조화된 `{code, message}` 객체를 받으므로 불필요.
 *
 * `": "` 앞이 dot-notation 코드 토큰(`command.not_found`, `internal`,
 * `math.divide_by_zero` 등 — 소문자/숫자/`.`/`_` 만)이면 code/message 를 분리하고,
 * 그렇지 않으면(FFI 수준 에러: `"json decode failed: ..."`, `"payload exceeds size limit"`
 * 등) `invoke.failed` 코드에 전체 문자열을 message 로 쓴다.
 */
export function parseRustraErrorString(error: string | undefined | null): RustraCommandError {
  const raw = error ?? 'Rustra invoke failed';
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; retryable?: unknown };
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        const retryable =
          typeof parsed.retryable === 'boolean' ? parsed.retryable : isRetryableCode(parsed.code);
        return new RustraCommandError(parsed.code, parsed.message, retryable);
      }
    } catch {
      // Fall through to plain text splitting
    }
  }
  const idx = raw.indexOf(': ');
  if (idx > 0) {
    const code = raw.slice(0, idx);
    if (/^[a-z][a-z0-9_.]*$/.test(code)) {
      return new RustraCommandError(code, raw.slice(idx + 2), isRetryableCode(code));
    }
  }
  return new RustraCommandError('invoke.failed', raw);
}

/**
 * Adapter/transport 경계에서 들어온 reject 값을 하나의 RustraCommandError로
 * 정규화한다. Promise rejection은 동기 throw와 달리 바깥 try/catch를 우회하므로
 * 모든 호스트가 이 helper를 `.catch()` 경로에도 사용해야 retryable 플래그가
 * JSON 와이어에서 유실되지 않는다.
 */
export function normalizeRustraError(error: unknown): RustraCommandError {
  if (error instanceof RustraCommandError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    return parseRustraErrorString(JSON.stringify(error));
  }
  if (error instanceof Error) {
    const normalized = parseRustraErrorString(error.message);
    normalized.cause = error;
    if (error.stack) normalized.stack = error.stack;
    return normalized;
  }
  if (typeof error === 'string') {
    // Plain transport strings are opaque failures, preserving the historical
    // `unknown` adapter contract. Structured Rustra JSON and Display strings
    // still go through the parser so retryable metadata is not lost.
    const parsed = parseRustraErrorString(error);
    return parsed.code === 'invoke.failed' ? new RustraCommandError('unknown', error) : parsed;
  }
  return new RustraCommandError('unknown', String(error));
}

/**
 * 코드 기반 retryable 추론 — Rust `RustraError` 팩토리 관례와 정합.
 * `transport.error`/`transport.timeout`은 Rust 생성 시점에 `retryable: true`로
 * 설정되는 코드군이며 (구조화 와이어에는 retryable 플래그가 없으므로 코드에서
 * 도출한다), `cancelled`도 Rust `RustraError::cancelled` 의 retryable:true 를
 * 미러링한다 (T1 — JSON fallback 경로의 취소 에러 정합).
 */
export function isRetryableCode(code: string): boolean {
  return code === 'transport.error' || code === 'transport.timeout' || code === 'cancelled';
}

/**
 * rustra 에러 코드의 중앙 레지스트리 — Rust `RustraError`(crates/rustra/src/error.rs)
 * 와 JS 어댑터가 발행하는 전체 코드 집합. 과거엔 각 소스에 문자열 리터럴로
 * 흩어져 있어 `err.code === 'transport.timeout'` 오타가 컴파일 타임에 안 잡혔다.
 * 상수를 쓰면 자동완성+타입 체크가 둘 다 동작한다:
 *
 * ```ts
 * import { RustraErrorCode } from '@rustra/types';
 * if (err.code === RustraErrorCode.TransportTimeout) { retry(); }
 * ```
 *
 * 새 코드 추가 시 여기와 Rust error.rs 를 함께 갱신한다(단일 소스 관례).
 */
export const RustraErrorCode = {
  /** 명령을 레지스트리에서 찾을 수 없음. */
  CommandNotFound: 'command.not_found',
  /** 인자 역직렬화/검증 실패. */
  CommandInvalidArgs: 'command.invalid_args',
  /** capability 미부여로 거부됨 (deny-by-default). */
  CapabilityDenied: 'capability.denied',
  /** 페이로드가 크기 한도(기본 1MiB)를 초과. */
  PayloadTooLarge: 'payload.too_large',
  /** transport 계열 일시 오류 — retryable. */
  TransportError: 'transport.error',
  /** 자동 host 탐색에서 실행 가능한 native transport를 찾지 못함. */
  TransportUnavailable: 'transport.unavailable',
  /** 타임아웃 레이스 만료 — retryable. */
  TransportTimeout: 'transport.timeout',
  /** 사전/협력적 취소 — retryable. */
  Cancelled: 'cancelled',
  /** Rust 내부 오류(패닉 정규화 포함). */
  Internal: 'internal',
  /** 동결 레지스트리의 구조 mutation 거부. */
  RegistryFrozen: 'registry.frozen',
  /** command_id 공간 고갈. */
  RegistryIdExhausted: 'registry.id_exhausted',
  /** FFI 전역 패키지 미등록. */
  FfiNotRegistered: 'ffi.not_registered',
  /** invoke 일반 실패(JS 폴백 기본 코드). */
  InvokeFailed: 'invoke.failed',
  /** 와이어 프레임 파싱 실패. */
  InvokeMalformed: 'invoke.malformed',
  /** 페이로드가 헤더보다 짧음. */
  InvokeTooShort: 'invoke.too_short',
  /** 스키마 조회 실패. */
  SchemaUnavailable: 'schema.unavailable',
  /** 계약 해시 불일치(JS>native stale). */
  ContractMismatch: 'contract.mismatch',
  /** 계약 해시 검증 불가(네이티브 미지원). */
  ContractUnenforceable: 'contract.unenforceable',
  /** 분류 불가 오류. */
  Unknown: 'unknown',
} as const;

export type RustraErrorCodeValue = (typeof RustraErrorCode)[keyof typeof RustraErrorCode];

/** 값이 알려진 rustra 에러 코드인지 검사 (타입 가드). */
export function isRustraErrorCode(code: string): code is RustraErrorCodeValue {
  return Object.values(RustraErrorCode).includes(code as RustraErrorCodeValue);
}
