/**
 * @rustra/tauri — Tauri 2용 rustra 엔진 어댑터
 *
 * Tauri 애플리케이션에서 rustra 명령을 실행할 수 있는 EngineClient 구현체를 제공합니다.
 * Rust 측의 `rustra_dispatch` Tauri 커맨드를 통해 모든 rustra 명령을 라우팅합니다.
 *
 * ## 설정
 *
 * Rust 측에서 `tauri` feature를 활성화하고 `rustra::tauri_support::register`로
 * 패키지를 등록해야 합니다.
 *
 * @example
 * ```ts
 * import { createTauriEngine } from '@rustra/tauri';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 *
 * const result = await addNumbers(engine, { a: 20, b: 22 }); // { value: 42 }
 * ```
 */

export type {
  EngineClient,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  InvokeOptions,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  ensureConfigured,
  invoke,
  createRkyvV2Engine,
} from '@rustra/types';

import {
  configureLazy,
  createJsonEngine,
  ensureConfigured,
  RustraErrorCode,
  RustraCommandError,
  type EngineClientWithBatch,
} from '@rustra/types';

/**
 * Tauri의 IPC invoke 함수 타입입니다.
 *
 * `window.__TAURI__.core.invoke`를 직접 전달하면 됩니다.
 *
 * @example
 * ```ts
 * const invoke: TauriInvoke = window.__TAURI__.core.invoke;
 * ```
 */
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export type TauriListen = (
  event: string,
  handler: (event: { payload: string }) => void,
) => Promise<() => void>;

type TauriGlobal = {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    event?: { listen?: TauriListen };
  };
};

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

function requireTauriInvoke(): TauriInvoke {
  const core = tauriGlobal().__TAURI__?.core;
  if (typeof core?.invoke !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri IPC was not found. Enable app.withGlobalTauri, or pass { invoke } to createTauriEngine().',
    );
  }
  return core.invoke.bind(core);
}

export type TauriEngineOptions = {
  /** Omit when Tauri `app.withGlobalTauri` is enabled. */
  invoke?: TauriInvoke;
};

/**
 * Tauri IPC로 EngineClient를 생성합니다.
 *
 * 내부적으로 모든 rustra 명령을 `rustra_dispatch` Tauri 커맨드로 라우팅합니다.
 * `{ command, args }` 형태로 래핑하여 전송합니다.
 *
 * @param options.invoke - Tauri IPC invoke 함수
 * @returns EngineClient 인터페이스를 충족하는 엔진
 *
 * @example
 * ```ts
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 * ```
 */
export function createTauriEngine(options: TauriEngineOptions = {}) {
  const tauriInvoke = options.invoke ?? requireTauriInvoke();
  return createJsonEngine(
    (command, args) => tauriInvoke('rustra_dispatch', { command, args }),
    (args) => args ?? {},
  );
}

export type TauriBootstrap = {
  /** Resolves after the lazily discovered Tauri engine is ready. */
  ready(): Promise<EngineClientWithBatch>;
};

/** Registers lazy global-Tauri setup for generated platform entrypoints. */
export function createTauriBootstrap(options: TauriEngineOptions = {}): TauriBootstrap {
  configureLazy(() => createTauriEngine(options));
  return { ready: () => ensureConfigured() as Promise<EngineClientWithBatch> };
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
