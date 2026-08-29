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
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return ['1', 'true', 'verbose'].includes(String(env?.RUSTRA_DEBUG ?? '').toLowerCase());
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
  bytes: ArrayBuffer,
  error?: string,
): void {
  const view = new Uint8Array(bytes);
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
