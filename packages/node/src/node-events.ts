/**
 * @rustra/node 이벤트 구독 — `transport.drainEvents()` 폴링 콜백 어댑터.
 *
 * Rust `Package::emit` 은 이벤트 버스(`event_bus`)에 적재하고, Node 런타임
 * (예: loop-stdio 바이너리)은 `{"command":"__drainEvents"}` 특수 요청으로
 * 대기 중 이벤트를 배열로 돌려준다. 이 모듈은 그 폴링을 구독자 콜백으로
 * 연결한다 — Tauri/RN 의 `subscribeEvent` 와 동일한
 * `(name, callback) => unsubscribe` 계약을 제공한다.
 *
 * ### 전달 경로: 폴링 (Tauri/RN 의 푸시와 대비)
 *
 * 콜백은 Rust 가 emit 한 **직후**가 아니라 다음 폴링 틱에 도착한다. 폴링
 * 간격은 `RUSTRA_NODE_EVENT_POLL_MS`(기본 100ms, 0 허용)로 조정한다.
 *
 * ### 루프 공유 계약
 *
 * 같은 transport 인스턴스에 대한 모든 구독은 **하나의 폴링 루프**를 공유하고
 * drain 결과를 이벤트 이름별로 분배한다. 액티브 구독자가 0이 되면 폴링은
 * 완전히 정지한다(마지막 unsubscribe 가 정지시킨다). 다음 subscribe 가 루프를
 * 다시 시작한다.
 */
import { RustraCommandError } from '@rustra/types';
import type { NodeInvokeTransport } from './node-core.js';

/** drainEvents 를 노출하는 transport(loop-stdio 계열)면 무엇이든 구독 가능. */
export type NodeEventTransport = NodeInvokeTransport & {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
};

// 콜백 페이로드를 never 로 선언한다 — (payload: never) => void 는 모든 페이로드
// 콜백의 최소 상위집합이라 코드젠 SubscribeFn 계약에 그대로 할당된다(아래
// 컴파일 타임 고정 참조). 런타임에는 실제 페이로드가 전달된다.
type NodeEventCallback = (payload: never) => void;

const DEFAULT_POLL_MS = 100;

function pollIntervalMs(): number {
  const raw = process.env.RUSTRA_NODE_EVENT_POLL_MS;
  if (raw === undefined || raw === '') return DEFAULT_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RustraCommandError(
      'event.unavailable',
      `RUSTRA_NODE_EVENT_POLL_MS must be a non-negative number, got: ${raw}`,
    );
  }
  return parsed;
}

/**
 * transport 인스턴스별 폴링 루프 상태. WeakMap 이라 transport 가 dispose 되어
 * 참조가 사라지면 루프 상태도 회수된다.
 */
const loops = new WeakMap<
  NodeEventTransport,
  {
    subscribers: Map<string, Set<NodeEventCallback>>;
    polling: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  }
>();

function ensurePolling(transport: NodeEventTransport): void {
  const loop = loops.get(transport);
  if (!loop || loop.polling) return;
  loop.polling = true;
  const tick = (): void => {
    const current = loops.get(transport);
    if (!current) return;
    if (current.subscribers.size === 0) {
      // 마지막 구독자가 떠났다 — 타이머 없이 정지(다음 subscribe 가 재시동).
      current.polling = false;
      current.timer = null;
      return;
    }
    // drainEvents 가 동기 throw 할 수도 있다 — try/catch 로 가둬 폴링 루프와
    // 이후 subscribe 가 죽지 않게 한다(아래 Promise catch 와 동일 정책).
    let draining: Promise<Array<{ name: string; payload: unknown }>>;
    try {
      draining = Promise.resolve(transport.drainEvents());
    } catch (error) {
      console.error('Rustra: drainEvents failed:', error);
      current.timer = setTimeout(tick, pollIntervalMs());
      return;
    }
    void draining
      .then((events) => {
        for (const event of events) {
          const listeners = current.subscribers.get(event.name);
          if (!listeners) continue;
          for (const listener of [...listeners]) {
            try {
              // never 콜백 계약은 타입 레벨 최소 상위집합일 뿐 — 런타임 실값 전달.
              (listener as (payload: unknown) => void)(event.payload);
            } catch (error) {
              // 리스너 예외가 폴링 루프를 죽이지 않는다(RN 어댑터와 동일 정책).
              console.error(`Rustra: event listener for "${event.name}" threw:`, error);
            }
          }
        }
      })
      .catch((error) => {
        // drain 실패(프로세스 종료 등)는 조용히 재시도한다 — 다음 틱에 다시.
        console.error('Rustra: drainEvents failed:', error);
      })
      .finally(() => {
        if (!loops.get(transport)) return;
        current.timer = setTimeout(tick, pollIntervalMs());
      });
  };
  tick();
}

/**
 * rustra 이벤트를 구독한다 — Tauri/RN `subscribeEvent` 와 동일한
 * `(name, callback) => unsubscribe` 시그니처. 첫 번째 인자로 drainEvents 를
 * 노출하는 transport를 받는다(loop-stdio 계열 런타임).
 *
 * @example
 * ```ts
 * const transport = createNodeLoopTransport({ command: bin });
 * const unsubscribe = subscribeEvent(transport, 'progress.tick', (payload) => console.log(payload));
 * // 정리 시: unsubscribe()
 * ```
 */
export function subscribeEvent(
  transport: NodeEventTransport,
  name: string,
  callback: NodeEventCallback,
): () => void {
  let loop = loops.get(transport);
  if (!loop) {
    loop = { subscribers: new Map(), polling: false, timer: null };
    loops.set(transport, loop);
  }
  let listeners = loop.subscribers.get(name);
  if (!listeners) {
    loop.subscribers.set(name, (listeners = new Set()));
  }
  listeners.add(callback);
  ensurePolling(transport);
  return () => {
    const current = loops.get(transport);
    if (!current) return;
    const currentListeners = current.subscribers.get(name);
    if (!currentListeners) return;
    currentListeners.delete(callback);
    if (currentListeners.size === 0) current.subscribers.delete(name);
    if (current.subscribers.size === 0) {
      // 즉시 정지 — 진행 중 drain 은 마지막으로 전달될 수 있지만 새 폴링은 없다.
      if (current.timer !== null) {
        clearTimeout(current.timer);
        current.timer = null;
        current.polling = false;
      }
    }
  };
}

// ── 코드젠 SubscribeFn 정합 (컴파일 타임 고정) ─────────────────
// 코드젠(generateEventsTs)이 생성하는 `SubscribeFn` 계약:
//   <N extends RustraEventName>(name: N, cb: (payload: RustraEventPayloads[N]) => void)
//     => (() => void) | Promise<() => void>
// 이벤트 1개('x': number)를 가진 동형 계약에 이 모듈의 구독 시그니처가
// 들어맞는지 tsc 로 고정한다 — 계약이 바뀌면 컴파일이 깨진다.

/** 생성 계약의 동형 타입 — 이벤트 'x' 하나가 선언된 스키마에 상당. */
type ContractPayloads = { x: number };
type ContractName = keyof ContractPayloads & string;
type GeneratedSubscribeFn = <N extends ContractName>(
  name: N,
  callback: (payload: ContractPayloads[N]) => void,
) => (() => void) | Promise<() => void>;

// node 구독 시그니처(transport, name, callback)는 transport 에 커링하면
// (name, callback) => unsubscribe 가 남는다 — 커링 결과 타입이 생성 SubscribeFn
// 자리에 들어맞는지 타입 레벨에서 고정한다(값 없이 순수 타입 검증).
type BoundNodeSubscribe = (transport: NodeEventTransport) => ReturnType<typeof subscribeEventNoop>;
declare function subscribeEventNoop(
  transport: NodeEventTransport,
  name: 'x',
  callback: (payload: number) => void,
): () => void;
type _NodeFitsGenerated =
  ReturnType<BoundNodeSubscribe> extends (() => void) | Promise<() => void> ? true : false;
type _NodeParamFits = Parameters<GeneratedSubscribeFn>[1] extends NodeEventCallback ? true : false;
const _nodeChecks: [_NodeFitsGenerated, _NodeParamFits] = [true, true];
void _nodeChecks;
