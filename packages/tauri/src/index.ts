/**
 * @rustra/tauri — Tauri 2용 rustra 엔진 어댑터
 *
 * Tauri 애플리케이션에서 rustra 명령을 실행할 수 있는 EngineClient 구현체를 제공합니다.
 * Rust 측의 `rustra_dispatch` Tauri 커맨드를 통해 모든 rustra 명령을 라우팅합니다.
 *
 * ## 설정
 *
 * Rust 측에서 `tauri` feature를 활성화하고 `rustra::tauri_support::register`로
 * 패키지를 등록해야 합니다.
 *
 * @example
 * ```ts
 * import { createTauriEngine } from '@rustra/tauri';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 *
 * const result = await addNumbers(engine, { a: 20, b: 22 }); // { value: 42 }
 * ```
 */

export type {
  EngineClient,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  InvokeOptions,
} from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

import { parseRustraErrorString, RustraCommandError, type InvokeOptions } from '@rustra/types';

/**
 * Tauri의 IPC invoke 함수 타입입니다.
 *
 * `window.__TAURI__.core.invoke`를 직접 전달하면 됩니다.
 *
 * @example
 * ```ts
 * const invoke: TauriInvoke = window.__TAURI__.core.invoke;
 * ```
 */
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

/**
 * Tauri IPC로 EngineClient를 생성합니다.
 *
 * 내부적으로 모든 rustra 명령을 `rustra_dispatch` Tauri 커맨드로 라우팅합니다.
 * `{ command, args }` 형태로 래핑하여 전송합니다.
 *
 * @param options.invoke - Tauri IPC invoke 함수
 * @returns EngineClient 인터페이스를 충족하는 엔진
 *
 * @example
 * ```ts
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 * ```
 */
export function createTauriEngine(options: { invoke: TauriInvoke }) {
  return {
    async invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      // signal 정책(전 어댑터 공통): abort 된 signal 만 cancelled 로 거부하고,
      // 미abort signal 은 정상 실행한다(얕은 취소 — Tauri IPC 는 취소 전파 불가).
      // useCommand 처럼 항상 signal 을 전달하는 호출부와의 호환을 위해 signal 존재
      // 자체를 에러로 삼지 않는다 — 매트릭스(docs/compatibility-matrix.md) 참고.
      if (invokeOptions?.signal?.aborted) {
        throw new RustraCommandError(
          'cancelled',
          `invoke("${command}") aborted before dispatch`,
          true,
        );
      }
      try {
        return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        // Rust 와이어 에러 — reason 이 RustraError JSON 또는 "code: message"
        // Display 문자열인 경우 parseRustraErrorString 이 code/retryable 을
        // 복원한다. @rustra/node 와 동일 파이프라인(unknown 래핑 방지).
        if (e instanceof Error) {
          throw parseRustraErrorString(e.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}

// ── 이벤트 구독 (Rust → JS push) ──────────────────────────
// Rust 측 `tauri_support::register_with_events` 가 `Package::emit` 을
// `app.emit("rustra://{sanitized}", payload_json)` 로 전달한다 — 이 섹션은 그
// 채널을 JS 에서 구독하는 래퍼다. 과거엔 Rust 푸시만 있고 JS 구독 API 가 없어
// 사용자가 채널 규약을 문서에서 해석해 직접 listen 배선해야 했다.

/** Tauri `listen` 함수 타입 — `window.__TAURI__.event.listen` 을 전달한다. */
export type TauriListen = (
  event: string,
  handler: (event: { payload: string }) => void,
) => Promise<() => void>;

/** rustra 이벤트명 → Tauri 채널명 (`rustra://{sanitized}`, Rust `event_channel` 과 동일 규칙). */
export function rustraEventChannel(name: string): string {
  const sanitized = name
    .split('')
    .map((c) => (/[A-Za-z0-9/_:-]/.test(c) ? c : '_'))
    .join('');
  return `rustra://${sanitized}`;
}

/**
 * rustra 이벤트를 구독한다 — Rust `Package::emit` 의 페이로드(JSON 문자열)를
 * 파싱해 콜백에 전달한다.
 *
 * @example
 * ```ts
 * const unsubscribe = subscribeEvent(
 *   window.__TAURI__.event.listen,
 *   'progress.tick',
 *   (payload) => console.log(payload),
 * );
 * // 정리 시: unsubscribe()
 * ```
 *
 * @returns unsubscribe 함수 (Tauri listen 이 반환하는 unlisten 그대로).
 */
export async function subscribeEvent<T = unknown>(
  listen: TauriListen,
  name: string,
  callback: (payload: T) => void,
): Promise<() => void> {
  const unlisten = await listen(rustraEventChannel(name), (event) => {
    // payload 는 Rust 가 JSON 직렬화한 문자열이다 — 파싱해 타입 값으로 전달.
    try {
      callback(JSON.parse(event.payload) as T);
    } catch {
      // 파싱 실패 시 원본 문자열이라도 전달한다(조용한 드롭 방지).
      callback(event.payload as unknown as T);
    }
  });
  return unlisten;
}
