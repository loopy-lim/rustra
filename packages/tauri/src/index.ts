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

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2Native } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

import { RustraCommandError } from '@rustra/types';

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
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}
