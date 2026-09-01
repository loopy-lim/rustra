/**
 * @rustra/node 이벤트 구독 — 2-모드 dispatch (push 우선, 폴링 폴백).
 *
 * Rust `Package::emit` 은 이벤트 버스(`event_bus`)에 적재하고, Node 런타임
 * (예: loop-stdio 바이너리)은 `{"command":"__drainEvents"}` 특수 요청으로
 * 대기 중 이벤트를 배열로 돌려준다. 이 모듈은 그 폴링(또는 푸시)을 구독자
 * 콜백으로 연결한다 — Tauri/RN 의 `subscribeEvent` 와 동일한
 * `(name, callback) => unsubscribe` 계약을 제공한다.
 *
 * ### 전달 경로: push 우선 (0xfffd 프레임), 폴링 폴백
 *
 * `onPushEvent` 경로를 노출하는 transport 면 폴링 루프 없이 푸시 구독으로
 * 시작한다 — Rust emit 이 stdout 0xfffd 프레임으로 즉시 도착한다(Bun FFI 푸시와
 * 동일 위상). 경로가 없으면 기존 폴링으로 폴백한다.
 *
 * 메서드 존재는 수신 "경로"의 노출일 뿐 능력 보장이 아니므로, `ready()` 를
 * 노출하는 transport(실 NodeLoopTransport)는 핸드셰이크 정착 후 `pushCapable`
 * 로 능력을 1회 재판정한다: 미수용(codecs 미제공, 구 런타임)이 확정되면 푸시를
 * 해지하고 폴링으로 이동한다 — 죽은 푸시 스트림에 조용히 갇히는 일이 없다.
 * 반대로 푸시 리스너는 구독 즉시 동기 부착되고, 런타임 싱크는 핸드셰이크 응답
 * **전에** 설치되므로(코어 `deliver_via_sink` 계약) 유실 창이 없다.
 *
 * 어느 쪽이든 콜백 페이로드는 폴링 drain 과 동일 셰이프로 정규화된다(푸시는
 * 문자열 JSON 을 구독자 도달 시점에 파싱 — 빈 문자열 null, 비 JSON 은 warn 후
 * 원본 문자열).
 *
 * ### push 모드는 "구독 이전 emit" 을 버린다 (폴링과의 차이)
 *
 * 폴링은 구독 전에 버스에 쌓인 emit 을 첫 drain 에서 받지만, push 모드는 싱크가
 * 버스를 우회하므로(코어 `deliver_via_sink` 계약) transport 생성~첫 subscribe
 * 사이의 emit 은 수신자 없이 버려진다. emit 이 구독보다 늦게 일어나도록 구독을
 * 먼저 하거나, 구독 전 emit 이 필요하면 폴링을 쓴다.
 *
 * ### 능력 부재 loud-fail 계약 (Task 5 이슈 A 해소)
 *
 * transport 가 `drainEvents` 도 `onPushEvent` 도 노출하지 않으면 — 예: one-shot
 * `invoke` 전용 바이너리에 붙인 transport — 이벤트가 **영원히 오지 않는다**.
 * 조용한 빈 스트림 대신 첫 구독에서 즉시 throw 한다(페어링 갭의 loud-fail).
 *
 * ### 루프 공유 계약
 *
 * 같은 transport 인스턴스에 대한 모든 구독은 **하나의 구독 테이블과 하나의
 * 전달 경로**를 공유한다(이름별 분배). 액티브 구독자가 0이면 폴링 타이머/푸시
 * 구독이 완전히 해지된다(마지막 unsubscribe 가 정지). 다음 subscribe 가 재시동
 * 한다. 능력 재판정은 transport 당 1회 — 확정 후엔 경로를 다시 바꾸지 않는다.
 */
import { RustraCommandError } from '@rustra/types';
import type { NodeInvokeTransport } from './node-core.js';

/**
 * 이벤트 구독 가능 transport — drainEvents(폴링) 또는 onPushEvent(푸시 경로)를
 * 노출한다. 둘 다 없으면 loud-fail(위 능력 부재 계약). 실 NodeLoopTransport 는
 * `ready()`/`pushCapable` 도 노출하며, dispatch 는 이를 능력 재판정에 쓴다.
 */
export type NodeEventTransport = NodeInvokeTransport & {
  drainEvents?(): Promise<Array<{ name: string; payload: unknown }>>;
  /** 푸시 수신 경로 — 0xfffd 프레임을 받는 loop transport 가 노출한다.
   * 존재는 능력이 아니라 경로 노출일 뿐이다(능력 재판정은 pushCapable). */
  onPushEvent?(handler: (event: { name: string; payload: string }) => void): () => void;
  /** 프로토콜 협상 정착 대기 — 있으면 정착 후 능력을 1회 재판정한다. */
  ready?(): Promise<void>;
  /** 푸시 능력 확정값 — 런타임이 `events:"push"` 핸드셰이크를 수용했는지.
   * false 확정 시 푸시 경로가 폴링으로 이동한다. */
  readonly pushCapable?: boolean;
};

// 콜백 페이로드를 never 로 선언한다 — (payload: never) => void 는 모든 페이로드
// 콜백의 최소 상위집합이라 코드젠 SubscribeFn 계약에 그대로 할당된다(아래
// 컴파일 타임 고정 참조). 런타임에는 실제 페이로드가 전달된다.
type NodeEventCallback = (payload: never) => void;

/** transport 인스턴스별 이벤트 루프 상태 — 구독 테이블 1개를 양 경로가 공유한다. */
type EventLoopState = {
  subscribers: Map<string, Set<NodeEventCallback>>;
  /** 전달 경로 — 구독 시 onPushEvent 존재로 초기 판정, 능력 재판정으로 1회 수정. */
  mode: 'push' | 'polling';
  /** 능력 재판정(ready → pushCapable) 실행 여부 — transport 당 1회. */
  capabilityChecked: boolean;
  // 폴링 경로 상태.
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  // 푸시 경로 상태 — transport-level 구독 1개(브로드캐스트 → 이름별 분배).
  detach: (() => void) | null;
};

/**
 * transport 인스턴스별 루프 상태. WeakMap 이라 transport 가 dispose 되어 참조가
 * 사라지면 상태도 회수된다.
 */
const loops = new WeakMap<NodeEventTransport, EventLoopState>();

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

/** 이름별 dispatch — 리스너 예외가 전달 경로(폴링 루프/푸시 리더)를 죽이지
 * 않는다(RN 어댑터와 동일 정책). */
function dispatch(
  loop: { subscribers: Map<string, Set<NodeEventCallback>> },
  name: string,
  payload: unknown,
): void {
  const listeners = loop.subscribers.get(name);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      // never 콜백 계약은 타입 레벨 최소 상위집합일 뿐 — 런타임 실값 전달.
      (listener as (payload: unknown) => void)(payload);
    } catch (error) {
      console.error(`Rustra: event listener for "${name}" threw:`, error);
    }
  }
}

function ensurePolling(transport: NodeEventTransport, loop: EventLoopState): void {
  if (loop.polling) return;
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
      draining = Promise.resolve(transport.drainEvents!());
    } catch (error) {
      console.error('Rustra: drainEvents failed:', error);
      current.timer = setTimeout(tick, pollIntervalMs());
      return;
    }
    void draining
      .then((events) => {
        for (const event of events) {
          dispatch(current, event.name, event.payload);
        }
      })
      .catch((error) => {
        // drain 실패(프로세스 종료 등)는 조용히 재시도한다 — 다음 틱에 다시.
        console.error('Rustra: drainEvents failed:', error);
      })
      .finally(() => {
        if (!loops.get(transport)) return;
        // drain 완료 사이에 구독자가 모두 떠났으면 재가동하지 않는다 —
        // 마지막 unsubscribe 가 정지시킨다는 루프 공유 계약(모듈 JSDoc).
        if (current.subscribers.size === 0) {
          current.polling = false;
          current.timer = null;
          return;
        }
        current.timer = setTimeout(tick, pollIntervalMs());
      });
  };
  tick();
}

/** 푸시 프레임 본문 파싱 — payload 는 문자열 JSON(폴링 drain 과 동일 셰이프
 * 경계: 여기서 한 번 파싱해 콜백엔 JS 값이 도달한다). 빈 문자열은 null, 비
 * JSON 페이로드는 warn 후 원본 문자열 전달(조용한 드롭 방지). */
function parsePushPayload(raw: string): unknown {
  try {
    return raw === '' ? null : JSON.parse(raw);
  } catch {
    console.warn('Rustra: event payload was not valid JSON; delivering raw string');
    return raw;
  }
}

/** 푸시 경로 시동 — transport-level `onPushEvent` 구독 1개만 건다(구독자 수와
 * 무관, 다수 구독자가 같은 브로드캐스트를 이름별로 분배). */
function ensurePush(transport: NodeEventTransport, loop: EventLoopState): void {
  if (loop.detach) return;
  loop.detach = transport.onPushEvent!((event) => {
    const current = loops.get(transport);
    if (!current) return;
    dispatch(current, event.name, parsePushPayload(event.payload));
  });
}

/** 구독 등록 후 전달 경로 확보 — 확정된 경로의 시동만 담당한다. */
function ensureDelivery(transport: NodeEventTransport, loop: EventLoopState): void {
  if (loop.mode === 'push') ensurePush(transport, loop);
  else ensurePolling(transport, loop);
}

/** 능력 재판정 — transport 당 1회. `ready()` 정착 후 `pushCapable === false` 가
 * 확정되면(핸드셰이크 미실행/미수용) 푸시를 해지하고 폴링으로 이동한다. 죽은
 * 푸시 스트림(조용한 빈 스트림) 방지가 목적인 1회 수정이며, true 확정/재판정
 * 완료 후엔 경로를 다시 바꾸지 않는다. */
function scheduleCapabilityVerdict(transport: NodeEventTransport, loop: EventLoopState): void {
  if (loop.capabilityChecked || !transport.onPushEvent || !transport.ready) return;
  loop.capabilityChecked = true;
  const settleFallback = (): void => {
    const current = loops.get(transport);
    if (!current || current.mode !== 'push') return;
    if (transport.pushCapable === false) {
      if (current.detach) {
        current.detach();
        current.detach = null;
      }
      current.mode = 'polling';
      if (current.subscribers.size > 0) ensurePolling(transport, current);
    }
  };
  void transport.ready().then(settleFallback, settleFallback);
}

/**
 * rustra 이벤트를 구독한다 — Tauri/RN `subscribeEvent` 와 동일한
 * `(name, callback) => unsubscribe` 시그니처. 첫 번째 인자로 이벤트 transport
 * 를 받는다. 푸시 경로가 있으면 폴링 없이 푸시로 시작하고(능력 미수용 확정 시
 * 폴링으로 이동), 없으면 폴링(`drainEvents`)으로 폴백한다(2-모드 dispatch —
 * 모듈 JSDoc 참조).
 *
 * @example
 * ```ts
 * const transport = createNodeLoopTransport({ command: bin, codecs });
 * const unsubscribe = subscribeEvent(transport, 'progress.tick', (payload) => console.log(payload));
 * // 정리 시: unsubscribe()
 * ```
 */
export function subscribeEvent(
  transport: NodeEventTransport,
  name: string,
  callback: NodeEventCallback,
): () => void {
  // 능력 부재 loud-fail (Task 5 이슈 A) — drain 도 push 경로도 없는 transport
  // (예: one-shot invoke 바이너리)는 이벤트가 영원히 오지 않는다. 조용한 빈
  // 스트림 대신 첫 구독에서 명확히 실패한다.
  if (!transport.onPushEvent && !transport.drainEvents) {
    throw new RustraCommandError(
      'event.unavailable',
      'This transport cannot deliver events: it exposes neither drainEvents (polling) nor onPushEvent (push, 0xfffd frames). Attach the subscription to a createNodeLoopTransport runtime (loop-stdio) instead of a one-shot invoke binary.',
    );
  }
  let loop = loops.get(transport);
  if (!loop) {
    loop = {
      subscribers: new Map(),
      mode: transport.onPushEvent ? 'push' : 'polling',
      capabilityChecked: false,
      polling: false,
      timer: null,
      detach: null,
    };
    loops.set(transport, loop);
  }
  let listeners = loop.subscribers.get(name);
  if (!listeners) {
    loop.subscribers.set(name, (listeners = new Set()));
  }
  listeners.add(callback);
  ensureDelivery(transport, loop);
  scheduleCapabilityVerdict(transport, loop);
  return () => {
    const current = loops.get(transport);
    if (!current) return;
    const currentListeners = current.subscribers.get(name);
    if (!currentListeners) return;
    currentListeners.delete(callback);
    if (currentListeners.size === 0) current.subscribers.delete(name);
    if (current.subscribers.size === 0) {
      // 즉시 정지 — 진행 중 drain 은 마지막으로 전달될 수 있지만 새 폴링/푸시
      // 구독은 남지 않는다(루프 공유 정지 계약, 모듈 JSDoc).
      if (current.timer !== null) {
        clearTimeout(current.timer);
        current.timer = null;
        current.polling = false;
      }
      if (current.detach) {
        current.detach();
        current.detach = null;
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
type BoundNodeSubscribe = (transport: NodeEventTransport) => () => void;
type _NodeFitsGenerated =
  ReturnType<BoundNodeSubscribe> extends (() => void) | Promise<() => void> ? true : false;
type _NodeParamFits = Parameters<GeneratedSubscribeFn>[1] extends NodeEventCallback ? true : false;
const _nodeChecks: [_NodeFitsGenerated, _NodeParamFits] = [true, true];
void _nodeChecks;
