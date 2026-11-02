export function errorSummary(error: unknown): { code?: string; message: string } {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as { code?: unknown; message: unknown };
    return {
      code: typeof value.code === 'string' ? value.code : undefined,
      message: String(value.message),
    };
  }
  return { message: String(error) };
}

export function snapshot(value: unknown, depth = 0, budget = { remaining: 4096 }): unknown {
  if (budget.remaining <= 0) return '[truncated]';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    budget.remaining -= typeof value === 'string' ? value.length : 8;
    return value;
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'function') return '[function]';
  if (depth >= 3) return '[depth limit]';
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => snapshot(item, depth + 1, budget));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      result[key] = snapshot(item, depth + 1, budget);
    }
    return result;
  }
  // 위 분기에서 null/문자열/숫자/불리언/bigint/undefined/함수/배열/객체를 모두
  // 처리했다 — 여기 남는 것은 symbol 하나뿐이다.
  if (typeof value === 'symbol') return value.toString();
  // 남는 것은 never 지만 규칙이 unknown 좁히기를 따라가지 못해 해제한다 —
  // 객체/배열 경로는 위에서 전부 처리됐다.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}
