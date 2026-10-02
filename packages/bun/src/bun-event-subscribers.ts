export type EventCallback = (payload: never) => void;

/** 이름별 구독자 집합 — 푸시/폴링 양 경로가 공유하는 분배 테이블. */
export class SubscriberMap {
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

  clear(): void {
    this.subscribers.clear();
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

export function parseJsonPayload(raw: string, name: string): unknown {
  try {
    return raw === '' ? null : JSON.parse(raw);
  } catch {
    // 비 JSON 페이로드는 원본 문자열로 전달(Tauri 어댑터와 동일한 조용한 드롭 방지).
    console.warn(`Rustra: event "${name}" payload was not valid JSON; delivering raw string`);
    return raw;
  }
}
