import { parseRustraErrorString, RustraCommandError } from '@rustra/types';
import { getRustraNative } from './react-native-core.js';

export type RustraEventNative = {
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  /** JS 폴링 drain(CallInvoker 없는 호스트). 처리된 이벤트 수 반환. */
  drainEvents?(): number;
};
export type RustraChannelNative = {
  createChannel?(callback: (payloadJson: string) => void): number;
  /** 바이너리 채널 — 콜백이 임의 바이트를 받는다(C++ createChannelBytes HostFunction). */
  createChannelBytes?(callback: (payload: ArrayBuffer | Uint8Array) => void): number;
  dropChannel?(handle: number): boolean;
};

export function createChannel(
  callback: (payload: unknown) => void,
  native: RustraChannelNative = getRustraNative(),
): { readonly handle: number; close(): boolean } {
  if (typeof native.createChannel !== 'function' || typeof native.dropChannel !== 'function') {
    throw new RustraCommandError(
      'channel.unavailable',
      'native module must expose createChannel() and dropChannel(); channel support is unavailable',
    );
  }
  let closed = false;
  const handle = native.createChannel((payloadJson) => {
    if (closed) return;
    try {
      callback(JSON.parse(payloadJson));
    } catch {
      callback(null);
    }
  });
  if (!Number.isSafeInteger(handle) || handle < 0)
    throw new RustraCommandError(
      'channel.unavailable',
      'native createChannel() returned an invalid handle; expected a non-negative safe integer',
    );
  return { handle, close: () => (closed ? false : ((closed = true), native.dropChannel!(handle))) };
}

/**
 * 바이너리 채널 생성 — 콜백은 rkyv V2 프레임 등 임의 바이트(ArrayBuffer)를
 * 받는다. JSON 경로(`createChannel`)와 동일한 핸들/close 계약, 한 핸들은 한
 * 경로로만 동작한다. 네이티브가 `createChannelBytes` 를 노출하지 않으면
 * `channel.unavailable` 로 loud-fail 한다.
 */
export function createBytesChannel(
  callback: (payload: Uint8Array) => void,
  native: RustraChannelNative = getRustraNative(),
): { readonly handle: number; close(): boolean } {
  if (typeof native.createChannelBytes !== 'function' || typeof native.dropChannel !== 'function') {
    throw new RustraCommandError(
      'channel.unavailable',
      'native module must expose createChannelBytes() and dropChannel(); binary channel support is unavailable',
    );
  }
  let closed = false;
  const handle = native.createChannelBytes((payload) => {
    if (closed) return;
    callback(payload instanceof Uint8Array ? payload : new Uint8Array(payload));
  });
  if (!Number.isSafeInteger(handle) || handle < 0)
    throw new RustraCommandError(
      'channel.unavailable',
      'native createChannelBytes() returned an invalid handle; expected a non-negative safe integer',
    );
  return { handle, close: () => (closed ? false : ((closed = true), native.dropChannel!(handle))) };
}

const nativeListeners = new WeakMap<
  RustraEventNative,
  Map<string, Set<(payload: unknown) => void>>
>();
type SubscribeOptions = {
  allowMissingNative?: boolean;
  /**
   * 폴링 drain 간격(ms) — `drainEvents` 를 노출하는 네이티브(CallInvoker 없는
   * 호스트)에서 JS 측 폴링 루프를 켠다. C++ 디스패처는 CallInvoker 없으면 큐에
   * 쌓아두고 JS 의 `drainEvents()` 폴링을 기다린다(RustraJSIBridge.cpp) — 이
   * 옵션이 없으면 그 큐가 영원히 소비되지 않는다. 기본 꺼짐(CallInvoker 호스트에
   *선 drain 폴링이 불필요하고, `onEvent` 콜백이 도착하는 즉시 전달되므로
   * 푸시 경로와 병행해도 무해하다 — drain 이 비어 있으면 0).
   */
  pollMs?: number;
};

/** 폴링 drain 루프 — 네이티브 인스턴스당 1개(WeakMap). drainEvents 가 존재하고
 * pollMs > 0 인 구독이 1개라도 있으면 가동한다. */
const pollTimers = new WeakMap<RustraEventNative, ReturnType<typeof setTimeout> | null>();

function ensurePollingDrain(native: RustraEventNative, pollMs: number): void {
  if (typeof native.drainEvents !== 'function' || pollMs <= 0) return;
  if (pollTimers.get(native) != null) return; // 이미 가동 중.
  const tick = (): void => {
    const timers = pollTimers.get(native);
    if (timers === undefined) return; // 모든 구독이 해제됨 — 정지.
    try {
      native.drainEvents!();
    } catch (error) {
      console.error('Rustra: drainEvents failed:', error);
    }
    pollTimers.set(native, setTimeout(tick, pollMs));
  };
  pollTimers.set(native, setTimeout(tick, pollMs));
}

function stopPollingDrain(native: RustraEventNative): void {
  const timer = pollTimers.get(native);
  if (timer != null) {
    clearTimeout(timer);
    pollTimers.set(native, null);
  }
}

export function subscribeEvent(
  name: string,
  cb: (payload: unknown) => void,
  options?: SubscribeOptions,
): () => void {
  const native: RustraEventNative = getRustraNative();
  if (typeof native.onEvent !== 'function') {
    if (options?.allowMissingNative) return () => {};
    throw new RustraCommandError(
      'event.unavailable',
      'native module does not expose onEvent(); event subscription is unavailable',
    );
  }
  let events = nativeListeners.get(native);
  if (!events) nativeListeners.set(native, (events = new Map()));
  let listeners = events.get(name);
  if (!listeners) {
    events.set(name, (listeners = new Set()));
    native.onEvent(name, (json) => {
      let payload: unknown = null;
      try {
        if (json) payload = JSON.parse(json);
      } catch {
        /* malformed payload stays null */
      }
      // Array.from — Expo 의 ES5 타겟에서 Set 순회는 downlevelIteration 이 필요하다.
      // forEach — 이벤트마다 Array.from 이 배열을 할당하지 않는다(핫패스).
      const listeners = events?.get(name);
      listeners?.forEach((listener) => {
        try {
          listener(payload);
        } catch (error) {
          console.error(`Rustra: event listener for "${name}" threw:`, error);
        }
      });
    });
  }
  listeners.add(cb);
  // 폴링 drain 옵션 — CallInvoker 없는 호스트(C++ 큐가 JS 폴링 대기)를 위한
  // JS 측 소비 루프. onEvent 푸시와 병행 무해(drain 이 비어 있으면 0).
  if (options?.pollMs !== undefined) ensurePollingDrain(native, options.pollMs);
  return () => {
    const current = events?.get(name);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      events?.delete(name);
      native.offEvent?.(name);
    }
    // 해당 네이티브의 모든 구독이 떠나면 폴링 루프도 정지한다.
    const all = nativeListeners.get(native);
    if (all && Array.from(all.values()).every((set) => set.size === 0)) stopPollingDrain(native);
  };
}

/** 동기 invoke 표면의 최소 구조 — 네이티브 전체(RustraJSINative) 없이도 테스트/부분 목(mock)이 가능하다. */
export type RustraSyncNative = {
  invokeTyped?(name: string, args: unknown): unknown;
};

/**
 * 동기 typed invoke — UI 핫패스 등 Promise 오버헤드를 제거하는 경로.
 * C++ `invokeTyped` fast path(encode → FFI → decode)를 그대로 쓰며 반환값은
 * 디코딩된 출력 그 자체다. 정적 코덱이 없는 명령/네이티브는
 * `sync.unavailable` 로 loud-fail 한다(폴백 정책은 호출자 소관).
 *
 * 계약: JS 런타임 스레드에서만 호출(JSI 스레드 친화성 — 다른 네이티브 경로와
 * 동일). 커맨드 에러는 `RustraCommandError`(code/message 유지)로 재발행된다.
 */
export function invokeTypedSync<T = unknown>(
  name: string,
  args?: unknown,
  native: RustraSyncNative = getRustraNative(),
): T {
  if (typeof native.invokeTyped !== 'function') {
    throw new RustraCommandError(
      'sync.unavailable',
      'native module does not expose invokeTyped(); synchronous invoke is unavailable',
    );
  }
  try {
    return native.invokeTyped(name, args ?? {}) as T;
  } catch (error) {
    if (error instanceof RustraCommandError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // C++ HostFunction 은 "code: message" 문자열 JSError 를 던진다 —
    // 안정 코드로 복원한다(파서는 JSON/"code: message" 양쪽 계약 지원).
    throw parseRustraErrorString(message);
  }
}
