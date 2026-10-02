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
import { createBunFfiEventBridge } from './bun-ffi-event-hub.js';
import { SubscriberMap, type EventCallback } from './bun-event-subscribers.js';
export { createBunFfiEventBridge } from './bun-ffi-event-hub.js';

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

const DEFAULT_POLL_MS = 100;

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
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (subscribers.remove(name, callback)) stop();
      };
    },
    dispose() {
      disposed = true;
      stop();
      subscribers.clear();
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
      return createBunFfiEventBridge(options.library);
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
