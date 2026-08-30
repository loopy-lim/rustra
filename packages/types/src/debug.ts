/** Opt-in runtime diagnostics for transport and wire debugging. */
export type RustraDebugEvent = {
  direction: 'request' | 'response' | 'error';
  transport: 'json' | 'rkyv' | 'typed';
  command: string;
  bytes?: string;
  byteLength?: number;
  value?: unknown;
  error?: string;
};

export type RustraDebugSink = (event: RustraDebugEvent) => void;

let configuredSink: RustraDebugSink | undefined;

/** Install a bounded diagnostic sink; passing undefined disables it. */
export function configureDebug(sink?: RustraDebugSink): void {
  configuredSink = sink;
}

/** Returns true for `RUSTRA_DEBUG=1|true|verbose` or the RN global switch. */
export function isRustraDebugEnabled(): boolean {
  const globalValue = (globalThis as { __RUSTRA_DEBUG__?: unknown }).__RUSTRA_DEBUG__;
  if (globalValue === true) return true;
  return shouldDumpWire();
}

/**
 * 순수 env 파싱 — `RUSTRA_DEBUG` 만을 검사한다(RN 글로벌 스위치 불포함).
 * 와이어 바이트 덤프(dumpWire)의 게이트로, 테스트에서 env 주입으로 검증한다.
 */
export function shouldDumpWire(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return ['1', 'true', 'verbose'].includes(String(env?.RUSTRA_DEBUG ?? '').toLowerCase());
}

/**
 * 방향 + 바이트 hex를 stderr로 덤프한다. `RUSTRA_DEBUG` 가 없으면 완전 무음이므로
 * 파이프로 연결된 프로세스에서 폐기되어도 안전하다. 요청/응답 바이트 정합을
 * 눈으로 확인할 때 쓰는 저수준 진단이다(구조화 값은 `configureDebug` 싱크 사용).
 */
export function dumpWire(
  direction: 'request' | 'response' | 'error',
  bytes: ArrayBuffer | ArrayBufferView,
): void {
  if (!shouldDumpWire()) return;
  // caller-buffer 경로(F2)는 소유 ArrayBuffer 대신 뷰를 넘긴다 — 같은 정합을 지원.
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = Array.from(view.subarray(0, 256), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  const truncated = view.byteLength > 256 ? `… (${view.byteLength} bytes total)` : '';
  process.stderr.write(`[rustra:wire] ${direction} ${hex}${truncated}\n`);
}

/** 테스트 전용 — env 파싱 캐시가 없으므로 env 정리만 명시적으로 돕는다. */
export function resetDebugEnvForTests(): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  delete env?.RUSTRA_DEBUG;
}

/** Emit diagnostics only when explicitly enabled; secrets are never logged by default. */
export function debugRustra(event: RustraDebugEvent): void {
  if (!isRustraDebugEnabled() && !configuredSink) return;
  const safeEvent = {
    ...event,
    value: event.value === undefined ? undefined : snapshot(event.value),
  };
  configuredSink?.(safeEvent);
  if (isRustraDebugEnabled()) {
    const logger = typeof console.debug === 'function' ? console.debug : console.log;
    logger('[rustra:debug]', safeEvent);
  }
}

/** Add a bounded hex preview to an event without retaining the full wire buffer. */
export function debugWire(
  direction: RustraDebugEvent['direction'],
  transport: RustraDebugEvent['transport'],
  command: string,
  bytes: ArrayBuffer | ArrayBufferView,
  error?: string,
): void {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const preview = Array.from(view.subarray(0, 128), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  debugRustra({
    direction,
    transport,
    command,
    bytes: preview,
    byteLength: view.byteLength,
    ...(error ? { error } : {}),
  });
}

function snapshot(value: unknown, depth = 0, budget = { remaining: 2048 }): unknown {
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
  if (depth >= 3) return '[depth limit]';
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => snapshot(item, depth + 1, budget));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32))
      result[key] = snapshot(item, depth + 1, budget);
    return result;
  }
  return `[${typeof value}]`;
}
