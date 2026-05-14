/**
 * @rustra/bun — Bun용 rustra 엔진 어댑터
 *
 * Bun 환경에서 rustra 명령을 실행할 수 있는 EngineClient 구현체를 제공합니다.
 * Bun의 FFI, subprocess 등 다양한 transport와 함께 사용할 수 있습니다.
 *
 * @example
 * ```ts
 * import { createBunEngine } from '@rustra/bun';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createBunEngine({
 *   invoke: (cmd, args) => bunFFI.invoke(cmd, args),
 * });
 *
 * const result = await addNumbers(engine, { a: 20, b: 22 }); // { value: 42 }
 * ```
 */

export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

import { RustraCommandError } from '@rustra/types';

/**
 * Bun transport가 구현해야 하는 인터페이스입니다.
 *
 * 실제 Rust 호출 메커니즘(Bun FFI, subprocess 등)을 추상화합니다.
 *
 * @example
 * ```ts
 * const transport: BunInvokeTransport = {
 *   invoke(command, args) {
 *     return myBunFFI.call(command, args);
 *   },
 * };
 * ```
 */
export type BunInvokeTransport = {
  /**
   * 명령을 transport를 통해 호출합니다.
   *
   * @param command - 명령 이름
   * @param args - 명령 인자 (선택적)
   * @returns 명령 실행 결과
   */
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

/**
 * Bun transport로 EngineClient를 생성합니다.
 *
 * transport에서 throw된 에러를 자동으로 {@link RustraCommandError}로 래핑합니다.
 * 에러 객체가 `code`와 `message` 속성을 가지면 해당 값을 보존하고,
 * 그렇지 않으면 `code: "unknown"`으로 래핑합니다.
 *
 * @param transport - Bun transport 구현체
 * @returns EngineClient 인터페이스를 충족하는 엔진
 *
 * @example
 * ```ts
 * const engine = createBunEngine({
 *   invoke: (cmd, args) => myFFILib.call(cmd, args),
 * });
 * ```
 */
export function createBunEngine(transport: BunInvokeTransport) {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        return (await transport.invoke(command, args)) as T;
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
