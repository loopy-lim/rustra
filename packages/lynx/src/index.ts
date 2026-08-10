/**
 * Lynx용 rustra 엔진 어댑터
 *
 * rkyv V2 바이너리 fast-path 엔진과 JSON 폴백 엔진을 제공한다.
 * Lynx Native Module(`NativeModules.RustraModule`)이 노출하는
 * `invokeRkyvV2(ArrayBuffer): ArrayBuffer` 인터페이스 위에서 동작한다.
 * 설정은 `@rustra/types`의 configure()를 사용한다.
 */

import type {
  EngineClient as EngineClientType,
  RkyvV2Codec,
  RkyvV2SchemaNative,
} from '@rustra/types';
import { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2SchemaNative } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

// ── Lynx Native Module 인터페이스 ───────────────────────────

/**
 * Lynx Native Module이 노출해야 하는 인터페이스 (rkyv V2 fast-path).
 * iOS Obj-C `RustraModule <LynxModule>` / Android Kotlin `@LynxMethod` 로 구현.
 */
export type RustraLynxNative = RkyvV2SchemaNative & {
  /**
   * (Phase A host capability) Rust/host → ReactLynx 이벤트 푸시 검증용.
   * 호스트가 BTS 스레드에서 주기적으로 cb(n) 을 호출한다.
   * 모든 호스트가 구현하지는 않는다 (optional).
   */
  subscribeTick?(cb: (n: number) => void): void;
};

/**
 * JSON 폴백 경로용 네이티브 인터페이스.
 * 네이티브 모듈이 `invoke(ArrayBuffer): ArrayBuffer` (JSON)만 노출할 때 사용.
 */
export type RustraLynxJsonNative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
};

// ── Fast sync engine (rkyv V2) ──────────────────────────────

/**
 * 고속 엔진 생성 옵션. rkyv V2 바이너리 경로를 필수로 사용한다 (최고 성능).
 */
export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, RkyvV2Codec<any, any>>;
};

/**
 * 고속 엔진 — Lynx Native Module의 `invokeRkyvV2`로 rkyv V2 바이너리 fast-path를 탄다.
 *
 * host-neutral `createRkyvV2Engine`으로 위임한다. 정적 명령은 codegen codec
 * registry(postcard fast-path), 동적 명령은 live schema 기반 Tier 3(JSON) fallback.
 *
 * @example
 * ```ts
 * import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
 * ```
 */
export function createFastEngine(
  native: RustraLynxNative,
  options: FastEngineOptions,
): EngineClientType {
  return createRkyvV2Engine(native, options.rkyvV2Codecs);
}

// ── JSON 폴백 엔진 (옵션) ──────────────────────────────────

/**
 * JSON 기반 엔진 — 네이티브 모듈이 JSON `invoke`만 노출할 때 사용.
 * rkyv V2 codec registry가 없는 환경의 폴백 경로.
 */
export function createLynxEngine(native: RustraLynxJsonNative): EngineClientType {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const json = JSON.stringify({ command, args });
      const payload = encoder.encode(json);
      const resultBytes = native.invoke(payload.buffer);
      const response = JSON.parse(decoder.decode(resultBytes)) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(response.error ?? 'Rustra invoke failed');
      }
      return response.result as T;
    },
  };
}

// ── Native module 접근 ─────────────────────────────────────

/**
 * Lynx 글로벌 `NativeModules.RustraModule`에서 네이티브 모듈을 가져온다.
 *
 * Lynx 런타임은 `NativeModules` 글로벌 객체를 제공하며, 각 네이티브 모듈은
 * `[globalConfig register_module:]`(iOS) / Lynx 모듈 설정(Android)으로 등록된다.
 * 등록 전에 호출하면 에러를 던진다.
 *
 * @example
 * ```ts
 * import { getRustraNative, createFastEngine, configure } from '@rustra/lynx';
 * configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: registry }));
 * ```
 */
export function getRustraNative(): RustraLynxNative {
  const nativeModules = (globalThis as Record<string, unknown>).NativeModules as
    Record<string, RustraLynxNative> | undefined;
  const native = nativeModules?.RustraModule;
  if (!native) {
    throw new Error(
      'Lynx NativeModules.RustraModule not registered. Register the native module via [globalConfig register_module:] (iOS) or your Lynx module setup (Android).',
    );
  }
  return native;
}

/**
 * (Phase A) Rust/host → ReactLynx 이벤트 푸시 검증용 tick 리스너 등록.
 * 호스트가 BTS 스레드에서 주기적으로 cb(counter)를 호출한다.
 * 네이티브 모듈이 subscribeTick 을 노출하지 않으면 no-op.
 *
 * @example
 * ```ts
 * import { subscribeTick } from '@rustra/lynx';
 * subscribeTick((n) => console.log('tick', n));
 * ```
 */
export function subscribeTick(cb: (n: number) => void): void {
  const native = getRustraNative();
  if (typeof native.subscribeTick === 'function') {
    native.subscribeTick(cb);
  }
}
