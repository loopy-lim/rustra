/**
 * 호스트 어댑터(node/bun)가 공유하는 폴링 이벤트 분배 코어.
 *
 * 루프 공유 계약(어댑터 JSDoc 과 동일):
 *  - 같은 소스에 대한 모든 구독이 하나의 폴링 루프를 공유한다.
 *  - 액티브 구독자가 0이면 폴링은 완전히 정지하고, 다음 subscribe 가 재시동한다.
 *  - drain 동기 throw / Promise 거부 모드 폴링 루프를 죽이지 않는다.
 *  - 리스너 예외는 격리된다(다른 리스너와 루프에 영향 없음).
 *
 * interval 결정(env 파싱, 옵션 기본값)은 어댑터 정책이므로 콜백으로 주입받는다.
 */

/** 이벤트 버스를 읽는 주입형 소스 — loop-stdio 계열 transport 와 호환. */
export type PollingEventSource = {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
};

export type PollingEventDistributor = {
  subscribe(name: string, callback: (payload: never) => void): () => void;
  /** 폴링 루프를 완전히 정지시킨다 — 이후 subscribe 는 no-op unsubscribe 를 돌려준다. */
  dispose(): void;
  /** 남은 구독자가 있는지 — dispose 정리 판단용. */
  isEmpty(): boolean;
};

/** 이름별 구독자 집합 — 푸시/폴링 양 경로가 공유하는 분배 테이블. */
export class SubscriberMap {
  private subscribers = new Map<string, Set<(payload: never) => void>>();

  add(name: string, callback: (payload: never) => void): void {
    let listeners = this.subscribers.get(name);
    if (!listeners) this.subscribers.set(name, (listeners = new Set()));
    listeners.add(callback);
  }

  /** 구독자를 제거하고(이름별 set이 비면 set 자체를 삭제) map이 비었는지 반환. */
  remove(name: string, callback: (payload: never) => void): boolean {
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
        // (payload: never) => void 는 모든 페이로드 콜백의 최소 상위집합이라
        // 런타임 값 전달은 안전하다(never 는 타입 레벨 계약일 뿐).
        (listener as (payload: unknown) => void)(payload);
      } catch (error) {
        // 리스너 예외가 브릿지를 죽이지 않는다(node/RN 어댑터와 동일 정책).
        console.error(`Rustra: event listener for "${name}" threw:`, error);
      }
    }
  }
}

/**
 * 폴링 분배기 — drain-tick 재시동 파이프라인의 단일 구현.
 * `intervalMs()` 는 매 재시동마다 조회된다(node 의 env 검증이 다음 틱에
 * 반영되는 현행 계약 유지).
 */
export function createPollingEventDistributor(options: {
  source: PollingEventSource;
  intervalMs: () => number;
}): PollingEventDistributor {
  const subscribers = new SubscriberMap();
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
      draining = Promise.resolve(options.source.drainEvents());
    } catch (error) {
      console.error('Rustra: drainEvents failed:', error);
      timer = setTimeout(tick, options.intervalMs());
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
        timer = setTimeout(tick, options.intervalMs());
      });
  };

  return {
    subscribe(name, callback) {
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
    isEmpty: () => subscribers.isEmpty(),
  };
}
