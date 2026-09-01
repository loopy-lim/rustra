/**
 * `createNodeBootstrap` 위의 이벤트 구독 조립 — 생성 엔트리(`node.ts`)가 export 하는
 * `subscribeEvent` 의 실체.
 *
 * ### Bun 팩토리(`createBunEventSubscription`)와의 대칭
 *
 * 같은 "엔트리는 팩토리를 조립하고 `subscribeEvent` 를 export 한다" 계약. Bun 이
 * 라이브러리 후보를 `bunLibraryCandidates` 로 재해상하듯, Node 는 부트스트랩과
 * **동일한 런타임 해상**(`resolveNodeRuntime` — `command` → `RUSTRA_NODE_BINARY` →
 * `commandCandidates` → `binaryName` 부모 디렉터리 탐색)을 재사용해 이벤트 transport
 * 를 스폰한다. 엔트리가 같은 옵션을 두 팩토리에 넘기면 두 해상이 같은 런타임을
 * 가리킨다.
 *
 * ### 전달 경로: 폴링 (Task 6 push 승격 전까지)
 *
 * transport 는 `drainEvents` 를 노출하는 loop-stdio 계열 런타임이고, 구독은
 * `node-events.ts` 의 폴링 `subscribeEvent` 로 위임한다(루프 공유/정지 계약 동일).
 * transport 생성은 동기이므로 Bun 쪽의 비동기 큐잉이 여기는 없다 — 첫 구독에서
 * transport 를 1회 생성(lazy)하고 이후 구독은 같은 transport 를 공유한다. 런타임이
 * push 능력을 갖추면(Task 6) 이 팩토리만 바꿔 끼우면 되고 엔트리 템플릿은 동일.
 */
import { createNodeLoopTransport, type NodeLoopTransport } from './node-loop.js';
import { subscribeEvent, type NodeEventTransport } from './node-events.js';
import { resolveNodeRuntime } from './node-bootstrap.js';
import type { NodeBootstrapOptions } from './node-core.js';

/** 부트스트랩과 동일한 런타임 해상 필드 — Pick 합성으로 필드 드리프트를 막는다
 * (contractHash 는 이벤트 transport 해상과 무관해 제외). */
export type NodeEventSubscriptionOptions = Pick<
  NodeBootstrapOptions,
  'command' | 'commandCandidates' | 'binaryName' | 'args' | 'spawnOptions'
>;

export type NodeEventSubscription = {
  /**
   * rustra 이벤트를 구독한다 — `(name, callback) => unsubscribe`(동기).
   * 첫 구독에서 이벤트 transport(loop-stdio 계열)를 생성한다.
   */
  subscribeEvent(name: string, callback: (payload: never) => void): () => void;
  /** 이벤트 transport 를 해제한다 — 종료 시 1회 호출. 생성 전 호출은 no-op. */
  dispose(): void;
};

/**
 * Node 이벤트 구독을 만든다. transport 는 첫 구독까지 지연된다 — 이벤트를 안 쓰는
 * 프로세스는 런타임 해상/스폰 비용을 내지 않는다.
 */
export function createNodeEventSubscription(
  options: NodeEventSubscriptionOptions = {},
): NodeEventSubscription {
  let transport: NodeLoopTransport | null = null;
  /** 이 팩토리가 건 구독의 해지 함수 — dispose 가 폴링 루프 구독자를 정리한다. */
  const unsubscribes = new Set<() => void>();

  const ensureTransport = (): NodeEventTransport => {
    if (!transport) {
      transport = createNodeLoopTransport({
        command: resolveNodeRuntime(options),
        args: options.args,
        spawnOptions: options.spawnOptions,
      });
    }
    return transport;
  };

  return {
    subscribeEvent(name, callback) {
      const unsubscribe = subscribeEvent(ensureTransport(), name, callback);
      unsubscribes.add(unsubscribe);
      return () => {
        unsubscribes.delete(unsubscribe);
        unsubscribe();
      };
    },
    dispose() {
      // transport 만 죽이면 폴링 루프의 구독자가 남아 drain EPIPE 재시도 좀비가
      // 된다 — 구독을 먼저 전부 해지해(구독자 0 → 루프 정지 계약) 루프를 멈춘 뒤
      // 프로세스를 끝낸다.
      for (const unsubscribe of [...unsubscribes]) unsubscribe();
      unsubscribes.clear();
      transport?.dispose();
      transport = null;
    },
  };
}

// ── 코드젠 SubscribeFn 정합 (컴파일 타임 고정) ─────────────────
// node-events.ts 의 고정과 동일 계약 — 구독 팩토리의 subscribeEvent 가 생성
// SubscribeFn 자리에 들어맞는지 tsc 로 고정한다(이 방향의 할당 가능성만 계약).

/** 생성 계약의 동형 타입 — 이벤트 'x' 하나가 선언된 스키마에 상당. */
type ContractPayloads = { x: number };
type ContractName = keyof ContractPayloads & string;
type GeneratedSubscribeFn = <N extends ContractName>(
  name: N,
  callback: (payload: ContractPayloads[N]) => void,
) => (() => void) | Promise<() => void>;

type _SubscriptionFitsGenerated =
  NodeEventSubscription['subscribeEvent'] extends GeneratedSubscribeFn ? true : false;
const _subscriptionFits: _SubscriptionFitsGenerated = true;
void _subscriptionFits;
