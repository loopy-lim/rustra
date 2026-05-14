/**
 * @rustra/react-native — React Native용 rustra 엔진 어댑터
 *
 * `@rustra/types`의 글로벌 invoke + RN JSI 전용 엔진을 제공합니다.
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/react-native';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * await installRustraJSI();
 * configure(createRkyvV2Engine(getRustraNative(), rkyvV2Registry));
 *
 * // 이후 어디서든
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2Native } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

export type RustraJSINative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

export function createReactNativeEngine(native: { invoke(payload: ArrayBuffer): ArrayBuffer }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const json = JSON.stringify({ command, args });
      const payload = encoder.encode(json);
      const resultBytes = native.invoke(payload.buffer);
      const resultJson = decoder.decode(resultBytes);
      const response = JSON.parse(resultJson) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(response.error ?? 'Rustra invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}
