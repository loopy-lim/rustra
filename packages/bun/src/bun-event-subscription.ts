/**
 * Synchronous event subscriptions for an already loaded Bun FFI library.
 *
 * The native sink is installed before the first subscribe call returns, so an
 * immediate native invocation cannot race asynchronous bridge initialization.
 * The bootstrap passes its selected library path here to preserve contract pairing.
 * An injected polling fallback initializes asynchronously and queues subscriptions
 * until ready. Disposal prevents either path from reviving the event bridge.
 */
import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import { bunLibraryCandidates, type BunFfiEngineOptions } from './bun-ffi-library.js';
import {
  createBunEventBridge,
  createBunFfiEventBridge,
  type BunEventBridge,
  type BunEventBridgeOptions,
} from './bun-events.js';

export type BunEventSubscriptionOptions = Pick<
  BunFfiEngineOptions,
  'library' | 'libraryCandidates' | 'libraryName'
> &
  Pick<BunEventBridgeOptions, 'poll' | 'fallbackToPolling' | 'pollIntervalMs'>;

export type BunEventSubscription = {
  /**
   * rustra 이벤트를 구독한다 — `(name, callback) => unsubscribe`(동기).
   * FFI 싱크는 호출 중 준비된다. 폴링 초기화 전 구독은 큐잉된다. dispose 후 호출은
   * fail-fast 로 throw 한다(초기화 부활 후보가 남지 않게).
   */
  subscribeEvent(name: string, callback: (payload: never) => void): () => void;
  /** 브릿지를 해제한다 — 종료 시 1회 호출. 초기화 정착 전이어도 확정(dispose 우선). */
  dispose(): void;
};

type EventCallback = (payload: never) => void;

function noLibraryError(): RustraCommandError {
  return new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    'No compatible Rustra Bun cdylib was found for event subscription. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.',
  );
}

/**
 * Bun 이벤트 구독을 만든다. 실제 브릿지(FFI 푸시, `poll` 지정 시 폴링 폴백)는
 * 첫 구독까지 지연된다 — 이벤트를 안 쓰는 프로세스는 dlopen 비용을 내지 않는다.
 */
export function createBunEventSubscription(
  options: BunEventSubscriptionOptions,
): BunEventSubscription {
  let bridge: BunEventBridge | null = null;
  let bridgeReady: Promise<void> | null = null;
  let failure: { error: unknown } | null = null;
  /** dispose 확정 — 초기화 정착이 dispose 를 추월해 브릿지를 부활시키지 않게. */
  let disposed = false;
  /** 브릿지 준비 전 구독 — 콜백당 엔트리 목록(같은 콜백을 다른 이름으로 구독 가능).
   * 등록 순서 보존(준비 시 목록 순서대로 위임). */
  const pending = new Map<
    EventCallback,
    Array<{ name: string; unsubscribe: (() => void) | null }>
  >();

  // narrowing 우회 — ensureBridge(클로저) 호출 뒤 TS 는 failure 의 재할당을
  // 추적하지 못해 null 로 좁혀버린다. 함수 경계를 거쳐 읽는다.
  const failureNow = (): { error: unknown } | null => failure;
  const bridgeNow = (): BunEventBridge | null => bridge;

  const ensureBridge = (): void => {
    if (bridgeReady || failure) return;
    const candidates = bunLibraryCandidates(options);
    if (candidates.length === 0 && !options.poll) {
      failure = { error: noLibraryError() };
      return;
    }
    if (candidates[0]) {
      try {
        bridge = createBunFfiEventBridge(candidates[0]);
        return;
      } catch (error) {
        if (!options.poll || options.fallbackToPolling === false) {
          failure = { error };
          return;
        }
        console.warn('Rustra: FFI event sink registration failed; falling back to polling:', error);
      }
    }
    bridgeReady = createBunEventBridge({
      poll: options.poll,
      fallbackToPolling: options.fallbackToPolling,
      pollIntervalMs: options.pollIntervalMs,
    })
      .then((ready) => {
        if (disposed) {
          // dispose 가 초기화 정착을 추월했다 — 위임 없이 즉시 해제(부활 방지).
          ready.dispose();
          return;
        }
        bridge = ready;
        for (const [callback, entries] of pending) {
          for (const entry of entries) {
            entry.unsubscribe = ready.subscribeEvent(entry.name, callback);
          }
        }
        pending.clear();
      })
      .catch((error: unknown) => {
        failure = { error };
      });
  };

  return {
    subscribeEvent(name, callback) {
      if (disposed) throw new Error('createBunEventSubscription: subscription was disposed');
      if (failure) throw failure.error;
      const initialized = bridgeNow();
      if (initialized) return initialized.subscribeEvent(name, callback);
      ensureBridge();
      // 동기 해상(후보 탐색) 실패는 ensureBridge 안에서 failure 로 고정된다 —
      // 같은 호출에서 즉시 전파한다(첫 구독자가 조용히 큐에 남지 않게).
      const synchronousFailure = failureNow();
      if (synchronousFailure) throw synchronousFailure.error;
      const prepared = bridgeNow();
      if (prepared) return prepared.subscribeEvent(name, callback);
      const entry = { name, unsubscribe: null as (() => void) | null };
      const entries = pending.get(callback);
      if (entries) entries.push(entry);
      else pending.set(callback, [entry]);
      return () => {
        // 브릿지 준비 전 해지: 큐에서 해당 엔트리만 제거(다른 이름 구독은 보존).
        // 준비 후 해지: 위임된 unsubscribe 로 실제 싱크/폴링 정리.
        const queued = pending.get(callback);
        const index = queued?.indexOf(entry) ?? -1;
        if (queued && index >= 0) {
          queued.splice(index, 1);
          if (queued.length === 0) pending.delete(callback);
          return;
        }
        entry.unsubscribe?.();
      };
    },
    dispose() {
      disposed = true;
      // 초기화 완료를 기다리지 않는다 — 정착 시 disposed 가드가 위임 없이 해제한다.
      bridge?.dispose();
      bridge = null;
      pending.clear();
    },
  };
}

// ── 코드젠 SubscribeFn 정합 (컴파일 타임 고정) ─────────────────
// bun-events.ts 의 고정과 동일 계약 — 구독 팩토리의 subscribeEvent 가 생성
// SubscribeFn 자리(onRustraEvent 의 subscribe 매개변수 등)에 들어맞는지 tsc 로
// 고정한다. 이 방향의 할당 가능성만 계약이다.

/** 생성 계약의 동형 타입 — 이벤트 'x' 하나가 선언된 스키마에 상당. */
type ContractPayloads = { x: number };
type ContractName = keyof ContractPayloads & string;
type GeneratedSubscribeFn = <N extends ContractName>(
  name: N,
  callback: (payload: ContractPayloads[N]) => void,
) => (() => void) | Promise<() => void>;

type _SubscriptionFitsGenerated =
  BunEventSubscription['subscribeEvent'] extends GeneratedSubscribeFn ? true : false;
const _subscriptionFits: _SubscriptionFitsGenerated = true;
void _subscriptionFits;
