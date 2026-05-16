/**
 * @rustra/node — Node.js용 rustra 엔진 어댑터
 *
 * `@rustra/types`의 글로벌 invoke + Node napi-rs 전용 엔진을 제공합니다.
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/node';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * configure(createRkyvV2Engine(nativeAddon, rkyvV2Registry));
 *
 * // 이후 어디서든
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2Native } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';
import { RustraCommandError } from '@rustra/types';

/**
 * Node.js transport가 구현해야 하는 인터페이스입니다.
 */
export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

/**
 * napi-rs 등 JSON transport로 EngineClient을 생성합니다.
 */
export function createNodeEngine(transport: NodeInvokeTransport) {
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
