// unknown 타입 에러를 로그/화면 표시용 문자열로 정규화한다.
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
