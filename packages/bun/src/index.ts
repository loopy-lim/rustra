/**
 * @rustra/bun — Bun용 rustra 엔진 어댑터
 *
 * `@rustra/types`의 글로벌 invoke + Bun FFI 전용 엔진을 제공합니다.
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/bun';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * configure(createRkyvV2Engine(ffiBridge, rkyvV2Registry));
 *
 * // 이후 어디서든
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2Native } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';
import { RustraCommandError } from '@rustra/types';

/**
 * Bun transport가 구현해야 하는 인터페이스입니다.
 */
export type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

/**
 * Bun FFI 등 JSON transport로 EngineClient을 생성합니다.
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
