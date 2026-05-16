/**
 * RN용 rustra 엔진 어댑터
 *
 * 글로벌 invoke + RN JSI 전용 엔진을 제공합니다.
 * 설정은 `@rustra/types`의 configure()를 사용합니다.
 */

import type { EngineClient as EngineClientType, RkyvV2Codec, RkyvV2Native, RustraNative } from '@rustra/types';
import { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

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

// ── Fast sync engine ──────────────────────────────────────────

/**
 * 동기 엔진 — JSI sync call로 Promise 오버헤드 없이 즉시 결과를 반환합니다.
 */
export type SyncEngineClient = {
  invoke<T>(command: string, args?: unknown): T;
};

/**
 * 고속 엔진 생성 옵션.
 *
 * - `rkyvV2` 코덱이 있으면 rkyv V2 바이너리 경로 사용 (최고 성능)
 * - 없으면 JSON 동기 경로 사용 (JSI만으로도 충분히 빠름)
 */
export type FastEngineOptions = {
  rkyvV2Codecs?: Map<string, import('@rustra/types').RkyvV2Codec<any, any>>;
};

/**
 * 고속 엔진 — JSI 동기 호출로 Promise 오버헤드 없이 결과를 반환합니다.
 *
 * rkyv V2 코덱이 제공되면 바이너리 경로, 아니면 JSON 경로를 사용합니다.
 *
 * @example
 * ```ts
 * import { createFastEngine } from '@rustra/react-native';
 * import { registry } from './generated/rkyv-registry.js';
 *
 * const native = global.__rustraNative;
 * const engine = createFastEngine(native, { rkyvV2Codecs: registry });
 * configure(engine);
 * ```
 */
/**
 * 글로벌 JSI 네이티브 모듈에 접근합니다.
 *
 * JSI가 설치된 후 `global.__rustraNative`에서 네이티브 모듈을 가져옵니다.
 * 설치 전에 호출하면 에러를 던집니다.
 *
 * @example
 * ```ts
 * import { getRustraNative } from '@rustra/react-native';
 * const native = getRustraNative();
 * const engine = createFastEngine(native, { rkyvV2Codecs: registry });
 * ```
 */
export function getRustraNative(): RustraNative {
  const native = (globalThis as any).__rustraNative;
  if (!native) {
    throw new Error(
      'JSI native module not installed. Call installRustraJSI() from your native module first.',
    );
  }
  return native as RustraNative;
}

export function createFastEngine(
  native: RustraJSINative,
  options?: FastEngineOptions,
): EngineClientType {
  if (options?.rkyvV2Codecs && options.rkyvV2Codecs.size > 0) {
    return createRkyvV2Engine(native, options.rkyvV2Codecs);
  }

  // JSON sync path — no rkyv codecs available
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
