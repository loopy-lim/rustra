/**
 * 코드젠 경고 수집기 — TS CLI 코드젠이 스키마를 `"unknown"` 폴백으로 매핑할 때
 * 타입 컨텍스트(정의/명령명 + 스키마 type 발췌)를 잃지 않게 모은다.
 *
 * Rust 측 `crates/rustra/src/codegen.rs` 의 thread-local 수집기와 동일한 계약:
 * 생성 세션 진입에서 clear → 명령/정의 루프에서 컨텍스트 설정 → 종료에서 take.
 * 경고는 생성 파일(types.ts 등)의 바이트 출력에 영향을 주지 않는다 — CLI가
 * stderr 로 별도 출력하는 진행 채널이다.
 */

/** 수집 중인 경고. Node 코드젠은 단일 스레드로 구동되므로 모듈 상태로 충분하다. */
let warnings: string[] = [];

let currentContext = '<unknown>';

export function clearCodegenWarnings(): void {
  warnings = [];
  currentContext = '<unknown>';
}

export function setCodegenContext(context: string): void {
  currentContext = context;
}

/** 스키마 type 발췌 — 폴백 경고에 첨부되는 타입 컨텍스트. */
function typeExcerpt(schema: { type?: string | string[] }): string {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.join(' | ');
  return 'untyped schema';
}

/**
 * 폴백 경고를 기록한다 — `tsTypeFromSchema`의 `"unknown"` 폴백 지점에서 호출.
 * 컨텍스트는 `generateTypesTs`/`generateCommandsTs` 명령 루프가 설정한다.
 */
export function recordUnknownFallback(schema: { type?: string | string[] }): 'unknown' {
  warnings.push(
    `${currentContext}: unmapped schema fell back to "unknown" (${typeExcerpt(schema)})`,
  );
  return 'unknown';
}

/** 수집된 경고를 소비한다 (생성 세션 종료점에서 호출). */
export function takeCodegenWarnings(): string[] {
  const taken = warnings;
  warnings = [];
  return taken;
}

/** CLI가 stderr로 출력하는 진단 라인. */
export function formatCodegenWarning(warning: string): string {
  return `[rustra:codegen] warning: ${warning}`;
}
