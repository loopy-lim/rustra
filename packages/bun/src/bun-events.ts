/**
 * @rustra/bun 이벤트 구독 — FFI 푸시 싱크 브릿지 (+ 주입형 폴링 폴백).
 *
 * ### 전달 경로: FFI 푸시 (Tauri/RN의 플랫폼 푸시, Node의 폴링과 대비)
 *
 * 기본 경로는 C 콜백 푸시 싱크다. Bun FFI `JSCallback` 으로
 * `rustra_ffi_event_sink_register` 를 등록하면 Rust `Package::emit` 이
 * 버스 적재 없이 즉시 콜백을 호출한다 — 폴링 루프 없이 실시간 수신.
 * (싱크가 설치되어 있는 동안 이벤트 버스는 비어 있다 — 푸시+폴링 이중 수신
 * 방지 계약, Rust `set_event_sink` 문서 참조.)
 *
 * ### 스레드 계약 (비threadsafe JSCallback 을 쓰는 이유)
 *
 * 의도적으로 `threadsafe: false` 다. Bun 1.4 의 threadsafe JSCallback 은
 * 포인터/문자열 인자 마샬링이 불안정해 가비지 값을 받는다(1.4.0 실증).
 * 비threadsafe 콜백은 JS 스레드에서만 호출해야 하므로, emit 이 JS 스레드(FFI
 * invoke 호출 체인)에서 일어나는 동기 핸들러가 전제다. Rust 백그라운드 스레드
 * (async 핸들러 등)에서 emit 하면 콜백이 JS 스레드 밖에서 호출되어 미정의
 * 동작이므로, 그런 호스트는 `poll` 폴백을 써야 한다.
 *
 * ### 폴백: 주입형 폴링 (`poll` 옵션)
 *
 * FFI를 쓸 수 없거나(라이브러리 미로딩), 비동기 핸들러가 백그라운드 스레드에서
 * emit 하는 호스트는 `poll: { drainEvents }` 를 주입한다 — Node 어댑터와 같은
 * setTimeout 백오프 폴링으로 이벤트 버스를 읽는다. 구독자 0이면 폴링 정지,
 * 다수 구독자가 한 루프를 공유한다(계약은 @rustra/node 와 동일).
 *
 * 시그니처는 코드젠 `SubscribeFn` / RN·Tauri `subscribeEvent` 와 동일한
 * `(name, callback) => unsubscribe` 다.
 */

/** 이벤트 버스를 읽는 주입형 소스 — loop-stdio 계열 transport 와 호환. */
export type BunEventDrainSource = {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
};

export type BunEventBridgeOptions = {
  /**
   * Rust cdylib 경로 — 브릿지가 자체 dlopen 으로 이벤트 심볼
   * (`rustra_ffi_event_sink_register/unregister`)을 노출해 푸시 싱크를 등록한다.
   * `createBunFfiEngine` 런타임의 `library` 문자열을 그대로 쓰면 된다.
   */
  library?: string;
  /** 폴링 폴백 소스 — 지정하면 FFI 대신(또는 FFI 실패 시) 폴링으로 받는다. */
  poll?: BunEventDrainSource;
  /** FFI 푸시 실패 시 폴링 폴백을 시도할지(기본 true, poll 이 있을 때만). */
  fallbackToPolling?: boolean;
  /** 폴백 폴링 간격(ms, 기본 100). */
  pollIntervalMs?: number;
};

export type BunEventBridge = {
  /**
   * rustra 이벤트를 구독한다 — `(name, callback) => unsubscribe`.
   * 페이로드는 JSON 직렬화 문자열에서 한 번 파싱된 JS 값이다.
   */
  subscribeEvent(name: string, callback: (payload: never) => void): () => void;
  /** 싱크 등록/폴링을 모두 해제한다 — 종료 시 1회 호출. */
  dispose(): void;
};

type EventCallback = (payload: never) => void;

const DEFAULT_POLL_MS = 100;

/** 이름별 구독자 집합 — 푸시/폴링 양 경로가 공유하는 분배 테이블. */
class SubscriberMap {
  private subscribers = new Map<string, Set<EventCallback>>();

  add(name: string, callback: EventCallback): void {
    let listeners = this.subscribers.get(name);
    if (!listeners) this.subscribers.set(name, (listeners = new Set()));
    listeners.add(callback);
  }

  /** 구독자를 제거하고(이름별 set이 비면 set 자체를 삭제) map이 비었는지 반환. */
  remove(name: string, callback: EventCallback): boolean {
    const listeners = this.subscribers.get(name);
    if (!listeners) return this.subscribers.size === 0;
    listeners.delete(callback);
    if (listeners.size === 0) this.subscribers.delete(name);
    return this.subscribers.size === 0;
  }

  isEmpty(): boolean {
    return this.subscribers.size === 0;
  }

  dispatch(name: string, payload: unknown): void {
    const listeners = this.subscribers.get(name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        // EventCallback 은 계약상 (payload: never) => void — 모든 페이로드 콜백의
        // 최소 상위집합이라 런타임 값 전달은 안전하다(never 는 타입 레벨 계약일 뿐).
        (listener as (payload: unknown) => void)(payload);
      } catch (error) {
        // 리스너 예외가 브릿지를 죽이지 않는다(node/RN 어댑터와 동일 정책).
        console.error(`Rustra: event listener for "${name}" threw:`, error);
      }
    }
  }
}

function parseJsonPayload(raw: string, name: string): unknown {
  try {
    return raw === '' ? null : JSON.parse(raw);
  } catch {
    // 비 JSON 페이로드는 원본 문자열로 전달(Tauri 어댑터와 동일한 조용한 드롭 방지).
    console.warn(`Rustra: event "${name}" payload was not valid JSON; delivering raw string`);
    return raw;
  }
}

/**
 * FFI 푸시 싱크 브릿지. `libraryPath` 의 cdylib 을 자체 dlopen 으로 열어
 * `rustra_ffi_event_sink_register`/`rustra_ffi_event_sink_unregister` 를
 * 노출하고 — 첫 구독에서 등록, 마지막 unsubscribe 에서 해제해 리소스를
 * 정확히 되돌린다. 같은 dylib 에 대한 2회 dlopen 은 로드 비용 없이 심볼
 * 노출만 확장한다(Bun 1.4 실증).
 */
async function createFfiEventBridge(
  libraryPath: string,
  _options: BunEventBridgeOptions,
): Promise<BunEventBridge> {
  const { dlopen, FFIType, JSCallback } = (await import('bun:ffi')) as typeof import('bun:ffi');
  const lib = dlopen(libraryPath, {
    rustra_ffi_event_sink_register: { args: ['ptr', 'ptr'], returns: FFIType.void },
    rustra_ffi_event_sink_unregister: { args: [], returns: FFIType.void },
  });
  const register = lib.symbols.rustra_ffi_event_sink_register;
  const unregister = lib.symbols.rustra_ffi_event_sink_unregister;

  const subscribers = new SubscriberMap();
  let callback: InstanceType<typeof JSCallback> | null = null;
  let disposed = false;

  const ensureRegistered = (): void => {
    if (callback || disposed) return;
    callback = new JSCallback(
      (_userData: unknown, name: string, payloadJson: string) => {
        subscribers.dispatch(name, parseJsonPayload(payloadJson, name));
      },
      // threadsafe:false — JS 스레드(FFI invoke 체인)에서만 호출 전제(모듈 JSDoc).
      { args: ['ptr', 'cstring', 'cstring'], returns: 'void' },
    );
    register(callback.ptr, null);
  };

  const maybeUnregister = (): void => {
    if (!callback || !subscribers.isEmpty()) return;
    unregister();
    callback.close();
    callback = null;
  };

  return {
    subscribeEvent(name, callback: EventCallback) {
      ensureRegistered();
      subscribers.add(name, callback);
      return () => {
        subscribers.remove(name, callback);
        maybeUnregister();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (callback) {
        unregister();
        callback.close();
        callback = null;
      }
    },
  };
}

/**
 * 폴링 폴백 브릿지 — Node 어댑터와 동일 계약(구독자 0이면 정지, 루프 공유).
 */
function createPollingEventBridge(options: BunEventBridgeOptions): BunEventBridge {
  const source = options.poll;
  if (!source) throw new Error('createBunEventBridge: poll source is required for polling mode');
  const subscribers = new SubscriberMap();
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    if (disposed) return;
    // drainEvents 가 동기 throw 할 수도 있다 — try/catch 로 가둬 폴링 루프와
    // 이후 subscribe 가 죽지 않게 한다(아래 Promise catch 와 동일 정책).
    let draining: Promise<Array<{ name: string; payload: unknown }>>;
    try {
      draining = Promise.resolve(source.drainEvents());
    } catch (error) {
      console.error('Rustra: drainEvents failed:', error);
      timer = setTimeout(tick, intervalMs);
      return;
    }
    void draining
      .then((events) => {
        for (const event of events) subscribers.dispatch(event.name, event.payload);
      })
      .catch((error) => {
        console.error('Rustra: drainEvents failed:', error);
      })
      .then(() => {
        if (disposed || subscribers.isEmpty()) {
          timer = null;
          return;
        }
        timer = setTimeout(tick, intervalMs);
      });
  };

  return {
    subscribeEvent(name, callback: EventCallback) {
      if (disposed) return () => {};
      subscribers.add(name, callback);
      if (timer === null) tick();
      return () => {
        if (subscribers.remove(name, callback)) stop();
      };
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

/**
 * Bun 이벤트 브릿지를 만든다.
 *
 * - `library` 지정: FFI 푸시 싱크 경로(기본 — 실시간 수신).
 * - `poll` 지정: 폴링 경로(Node 어댑터 계약과 동일).
 * - 둘 다 지정: FFI 등록 실패 시 `fallbackToPolling`(기본 true)로 폴백.
 */
export async function createBunEventBridge(
  options: BunEventBridgeOptions,
): Promise<BunEventBridge> {
  if (options.library) {
    try {
      return await createFfiEventBridge(options.library, options);
    } catch (error) {
      if (!options.poll || options.fallbackToPolling === false) throw error;
      console.warn('Rustra: FFI event sink registration failed; falling back to polling:', error);
    }
  }
  return createPollingEventBridge(options);
}

// ── 코드젠 SubscribeFn 정합 (컴파일 타임 고정) ─────────────────
// 코드젠(generateEventsTs)이 생성하는 `SubscribeFn` 계약:
//   <N extends RustraEventName>(name: N, cb: (payload: RustraEventPayloads[N]) => void)
//     => (() => void) | Promise<() => void>
// 이벤트 1개('x': number)를 가진 동형 계약에 이 브릿지의 구독 시그니처가
// 들어맞는지 tsc 로 고정한다 — 계약이 바뀌면 컴파일이 깨진다.

/** 생성 계약의 동형 타입 — 이벤트 'x' 하나가 선언된 스키마에 상당. */
type ContractPayloads = { x: number };
type ContractName = keyof ContractPayloads & string;
type GeneratedSubscribeFn = <N extends ContractName>(
  name: N,
  callback: (payload: ContractPayloads[N]) => void,
) => (() => void) | Promise<() => void>;

// 브릿지 subscribeEvent 는 생성 SubscribeFn 자리(onRustraEvent 의 subscribe
// 매개변수 등)에 그대로 쓰인다 — 이 방향의 할당 가능성만 계약이다.
type _BridgeFitsGenerated = BunEventBridge['subscribeEvent'] extends GeneratedSubscribeFn
  ? true
  : false;
const _bridgeFits: _BridgeFitsGenerated = true;
void _bridgeFits;
