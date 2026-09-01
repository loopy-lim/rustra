/**
 * `createBunBootstrap` 위의 이벤트 구독 조립 — 생성 엔트리(`bun.ts`)가 export 하는
 * `subscribeEvent` 의 실체.
 *
 * ### 왜 별도 팩토리인가 (부트스트랩 통합이 아니라)
 *
 * `createBunBootstrap` 은 invoke 엔진을 위해 cdylib 을 dlopen 하고, 이벤트 브릿지
 * (`createBunEventBridge`)는 싱크 등록을 위해 **같은 dylib 을 다시 dlopen** 한다.
 * Bun 1.4 실증상 같은 dylib 의 2회 dlopen 은 로드 비용 없이 심볼 노출만 확장하므로
 * (bun-events.ts 모듈 JSDoc), 별도 dlopen 이 허용된다. 대신 라이브러리 **경로 계산은
 * 절대 이원화하지 않는다** — `bunLibraryCandidates` 를 그대로 재사용해 부트스트랩과
 * 동일한 우선순위(explicit `library` → `libraryCandidates` → `libraryName` 추론 →
 * `RUSTRA_BUN_LIBRARY` 오버라이드)로 해상한다. 엔트리가 같은 옵션을 두 팩토리에
 * 넘기면 두 해상이 항상 같은 파일을 가리킨다.
 *
 * ### 비동기 흡수 계약
 *
 * 브릿지 초기화(dlopen + 심볼 노출)는 비동기지만 구독 시그니처는 생성 `SubscribeFn`
 * 및 RN/Tauri `subscribeEvent` 와 동일한 **동기** `(name, callback) => unsubscribe`
 * 다. 첫 구독이 초기화를 kick 하고, 콜백은 큐에 적재됐다가 브릿지가 준비되면 등록
 * 순서대로 위임된다 — 초기화 창(window) 동안 구독 자체는 유실되지 않는다. 초기화에
 * 실패하면 실패가 고정되고 이후 subscribe 호출이 그 오류를 동기 throw 한다(fail-fast;
 * cdylib 재빌드 후 프로세스 재시작이 회복 경로 — bun-ffi reload 계약과 동일).
 */
import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import { bunLibraryCandidates, type BunFfiEngineOptions } from './bun-ffi-library.js';
import {
  createBunEventBridge,
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
   * 브릿지 초기화 전 구독은 큐잉됐다가 준비 즉시 위임된다. dispose 후 호출은
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

  const ensureBridge = (): void => {
    if (bridgeReady || failure) return;
    const candidates = bunLibraryCandidates(options);
    if (candidates.length === 0 && !options.poll) {
      failure = { error: noLibraryError() };
      return;
    }
    bridgeReady = createBunEventBridge({
      library: candidates[0],
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
      if (bridge) return bridge.subscribeEvent(name, callback);
      ensureBridge();
      // 동기 해상(후보 탐색) 실패는 ensureBridge 안에서 failure 로 고정된다 —
      // 같은 호출에서 즉시 전파한다(첫 구독자가 조용히 큐에 남지 않게).
      const synchronousFailure = failureNow();
      if (synchronousFailure) throw synchronousFailure.error;
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
