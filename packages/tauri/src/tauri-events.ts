import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import type { TauriListen } from './index.js';

type TauriGlobal = {
  __TAURI__?: { event?: { listen?: TauriListen } };
};

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

// ── 이벤트 구독 (Rust → JS push) ──────────────────────────
// Rust 측 `tauri_support::register_with_events` 가 `Package::emit` 을
// `app.emit("rustra://{sanitized}", payload_json)` 로 전달한다 — 이 섹션은 그
// 채널을 JS 에서 구독하는 래퍼다. 과거엔 Rust 푸시만 있고 JS 구독 API 가 없어
// 사용자가 채널 규약을 문서에서 해석해 직접 listen 배선해야 했다.

function requireTauriListen(): TauriListen {
  const events = tauriGlobal().__TAURI__?.event;
  if (typeof events?.listen !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri event.listen was not found. Enable app.withGlobalTauri, or pass a listen function.',
    );
  }
  return events.listen.bind(events);
}

/** rustra 이벤트명 → Tauri 채널명 (`rustra://{sanitized}`, Rust `event_channel` 과 동일 규칙). */
export function rustraEventChannel(name: string): string {
  const sanitized = name
    .split('')
    .map((c) => (/[A-Za-z0-9/_:-]/.test(c) ? c : '_'))
    .join('');
  return `rustra://${sanitized}`;
}

/**
 * rustra 이벤트를 구독한다 — 모든 어댑터와 같은 `(name, callback[, listen])`
 * 형태를 기본으로 사용한다. 기존 `(listen, name, callback)`도 0.x 호환으로
 * 지원한다. Rust `Package::emit`의 JSON 페이로드는 여기서 한 번 파싱한다.
 *
 * @example
 * ```ts
 * const unsubscribe = await subscribeEvent('progress.tick', (payload) => console.log(payload));
 * // 정리 시: unsubscribe()
 * ```
 */
export function subscribeEvent<T = unknown>(
  name: string,
  callback: (payload: T) => void,
  listen?: TauriListen,
): Promise<() => void>;
/** @deprecated Pass `(name, callback[, listen])`; this overload remains for 0.x compatibility. */
export function subscribeEvent<T = unknown>(
  listen: TauriListen,
  name: string,
  callback: (payload: T) => void,
): Promise<() => void>;
export async function subscribeEvent<T = unknown>(
  listenOrName: TauriListen | string,
  nameOrCallback: string | ((payload: T) => void),
  callbackOrListen?: ((payload: T) => void) | TauriListen,
): Promise<() => void> {
  const legacyShape = typeof listenOrName === 'function';
  const listen = legacyShape
    ? listenOrName
    : ((callbackOrListen as TauriListen | undefined) ?? requireTauriListen());
  const name = legacyShape ? (nameOrCallback as string) : listenOrName;
  const callback = (legacyShape ? callbackOrListen : nameOrCallback) as (payload: T) => void;
  const unlisten = await listen(rustraEventChannel(name), (event) => {
    // payload 는 Rust 가 JSON 직렬화한 문자열이다 — 파싱해 타입 값으로 전달.
    try {
      callback(JSON.parse(event.payload) as T);
    } catch {
      // 파싱 실패 시 원본 문자열이라도 전달한다(조용한 드롭 방지).
      callback(event.payload as unknown as T);
    }
  });
  return unlisten;
}

/** Tauri global event API를 자동 감지하는 zero-config 구독 래퍼. */
export function subscribeTauriEvent<T = unknown>(
  name: string,
  callback: (payload: T) => void,
  listen: TauriListen = requireTauriListen(),
): Promise<() => void> {
  return subscribeEvent(name, callback, listen);
}
