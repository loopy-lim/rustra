import { parseRustraErrorString, RustraCommandError } from '@rustra/types';
import { getRustraNative } from './react-native-core.js';

export type RustraEventNative = {
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  /** JS 폴링 drain(CallInvoker 없는 호스트). 처리된 이벤트+채널 프레임 수 반환. */
  drainEvents?(): number;
};
export type RustraChannelNative = {
  createChannel?(callback: (payloadJson: string) => void): number;
  /** 바이너리 채널 — 콜백이 임의 바이트를 받는다(C++ createChannelBytes HostFunction). */
  createChannelBytes?(callback: (payload: ArrayBuffer | Uint8Array) => void): number;
  dropChannel?(handle: number): boolean;
  /** Captures the producing native core; older native modules use dropChannel. */
  bindChannelClose?(handle: number): () => boolean;
  /** JS 폴링 drain(CallInvoker 없는 호스트) — 이벤트와 채널 프레임을 함께
   * 소비하고 처리한 프레임 수를 반환한다(C++ drainEvents HostFunction). */
  drainEvents?(): number;
};

function assertChannelNative(valid: boolean, message: string): void {
  if (!valid) {
    throw new RustraCommandError('channel.unavailable', message);
  }
}

function bindChannelLifecycle(
  native: RustraChannelNative,
  options: PollingDrainOptions | undefined,
  invalidHandleMessage: string,
  register: (isClosed: () => boolean) => number,
): { readonly handle: number; close(): boolean } {
  let closed = false;
  const handle = register(() => closed);
  if (!Number.isSafeInteger(handle) || handle <= 0)
    throw new RustraCommandError('channel.unavailable', invalidHandleMessage);
  let drop: () => boolean;
  try {
    drop =
      typeof native.bindChannelClose === 'function'
        ? native.bindChannelClose(handle)
        : () => native.dropChannel!(handle);
  } catch (error) {
    closed = true;
    native.dropChannel!(handle);
    throw error;
  }
  // 폴링 drain — CallInvoker 없는 호스트의 채널 큐 소비(SubscribeOptions.pollMs
  // 와 동일 계약). 수명은 채널에 귀속 — close 가 수요를 해제한다.
  const releasePolling = acquirePollingDemand(native, options?.pollMs);
  return {
    handle,
    close: () => {
      if (closed) return false;
      closed = true;
      releasePolling();
      return drop();
    },
  };
}

export function createChannel(
  callback: (payload: unknown) => void,
  native: RustraChannelNative = getRustraNative(),
  options?: PollingDrainOptions,
): { readonly handle: number; close(): boolean } {
  assertChannelNative(
    typeof native.createChannel === 'function' && typeof native.dropChannel === 'function',
    'native module must expose createChannel() and dropChannel(); channel support is unavailable',
  );
  return bindChannelLifecycle(
    native,
    options,
    'native createChannel() returned an invalid handle; expected a positive safe integer',
    (isClosed) =>
      native.createChannel!((payloadJson) => {
        if (isClosed()) return;
        let payload: unknown = null;
        try {
          payload = JSON.parse(payloadJson);
        } catch {
          /* malformed payload stays null */
        }
        callback(payload);
      }),
  );
}

/**
 * 바이너리 채널 생성 — 콜백은 Frame 프레임 등 임의 바이트(ArrayBuffer)를
 * 받는다. JSON 경로(`createChannel`)와 동일한 핸들/close 계약, 한 핸들은 한
 * 경로로만 동작한다. 네이티브가 `createChannelBytes` 를 노출하지 않으면
 * `channel.unavailable` 로 loud-fail 한다.
 */
export function createBytesChannel(
  callback: (payload: Uint8Array) => void,
  native: RustraChannelNative = getRustraNative(),
  options?: PollingDrainOptions,
): { readonly handle: number; close(): boolean } {
  assertChannelNative(
    typeof native.createChannelBytes === 'function' && typeof native.dropChannel === 'function',
    'native module must expose createChannelBytes() and dropChannel(); binary channel support is unavailable',
  );
  return bindChannelLifecycle(
    native,
    options,
    'native createChannelBytes() returned an invalid handle; expected a positive safe integer',
    (isClosed) =>
      native.createChannelBytes!((payload) => {
        if (isClosed()) return;
        callback(payload instanceof Uint8Array ? payload : new Uint8Array(payload));
      }),
  );
}

const nativeListeners = new WeakMap<
  RustraEventNative,
  Map<string, Set<(payload: unknown) => void>>
>();

/** 폴링 drain 수요의 WeakMap 키가 되는 최소 구조 — 이벤트/채널 네이티브 양쪽이
 * 공유하는 drainEvents 만 요구한다(네이티브 인스턴스당 수요 집계). */
type PollingDrainNative = {
  drainEvents?(): number;
};

type PollingDrainOptions = {
  /**
   * 폴링 drain 간격(ms) — `drainEvents` 를 노출하는 네이티브(CallInvoker 없는
   * 호스트)에서 JS 측 폴링 루프를 켠다. C++ 디스패처는 CallInvoker 없으면 큐에
   * 쌓아두고 JS 의 `drainEvents()` 폴링을 기다린다(RustraJSIBridge.cpp) — 이
   * 옵션이 없으면 그 큐가 영원히 소비되지 않는다. 기본 꺼짐(CallInvoker 호스트에
   * 서 drain 폴링이 불필요하고, 푸시 경로와 병행해도 무해하다 — drain 이 비어
   * 있으면 0).
   */
  pollMs?: number;
};
type SubscribeOptions = {
  allowMissingNative?: boolean;
} & PollingDrainOptions;

/** 폴링 drain 루프 — 네이티브 인스턴스당 1개(WeakMap). drainEvents 가 존재하고
 * pollMs > 0 인 소비자(이벤트 구독/채널)가 1개라도 있으면 가동한다. 간격은 첫
 * 수요자의 pollMs 를 따른다. */
type PollingLoop = {
  demand: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const pollingLoops = new WeakMap<PollingDrainNative, PollingLoop>();

function acquirePollingDemand(native: PollingDrainNative, pollMs: number | undefined): () => void {
  if (
    typeof native.drainEvents !== 'function' ||
    pollMs === undefined ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  ) {
    return () => {};
  }
  let loop = pollingLoops.get(native);
  if (!loop) {
    const created: PollingLoop = { demand: 0, timer: null };
    pollingLoops.set(native, created);
    const tick = (): void => {
      if (pollingLoops.get(native) !== created) return;
      created.timer = null;
      try {
        native.drainEvents!();
      } catch (error) {
        console.error('Rustra: drainEvents failed:', error);
      }
      // A callback may close the last owner and acquire a replacement loop.
      // The retired tick must not schedule another timer for that replacement.
      if (pollingLoops.get(native) === created) {
        created.timer = setTimeout(tick, pollMs);
      }
    };
    created.timer = setTimeout(tick, pollMs);
    loop = created;
  }
  const heldLoop = loop;
  heldLoop.demand += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldLoop.demand -= 1;
    if (heldLoop.demand === 0) {
      pollingLoops.delete(native);
      if (heldLoop.timer !== null) clearTimeout(heldLoop.timer);
    }
  };
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
    try {
      native.onEvent(name, (json) => {
        let payload: unknown = null;
        try {
          if (json) payload = JSON.parse(json);
        } catch {
          /* malformed payload stays null */
        }
        // Snapshot before callbacks: Set.forEach revisits deleted/re-added listeners
        // and can loop forever when a callback resubscribes itself.
        const listeners = events?.get(name);
        if (!listeners) return;
        Array.from(listeners).forEach((listener) => {
          if (!listeners.has(listener)) return;
          try {
            listener(payload);
          } catch (error) {
            console.error(`Rustra: event listener for "${name}" threw:`, error);
          }
        });
      });
    } catch (error) {
      events.delete(name);
      throw error;
    }
  }
  listeners.add(cb);
  // 폴링 drain 옵션 — CallInvoker 없는 호스트(C++ 큐가 JS 폴링 대기)를 위한
  // JS 측 소비 루프. onEvent 푸시와 병행 무해(drain 이 비어 있으면 0).
  const releasePolling = acquirePollingDemand(native, options?.pollMs);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try {
      const current = events?.get(name);
      if (current) {
        current.delete(cb);
        if (current.size === 0) {
          events?.delete(name);
          native.offEvent?.(name);
        }
      }
    } finally {
      releasePolling();
    }
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
