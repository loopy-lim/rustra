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
import {
  RustraCommandError,
  configure,
  invoke,
  createRkyvV2Engine,
  parseRustraErrorString,
} from '@rustra/types';

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2SchemaNative } from '@rustra/types';
export {
  RustraCommandError,
  configure,
  invoke,
  createRkyvV2Engine,
  parseRustraErrorString,
} from '@rustra/types';

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
  /**
   * (F5, opt-in) 빌드 시점 계약 해시. 설정하면 엔진 생성 시 네이티브의
   * 실시간 해시(getContractHash)와 비교해 불일치 시 즉시 throw 한다.
   */
  contractHash?: string;
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
  return createRkyvV2Engine(native, options.rkyvV2Codecs, {
    contractHash: options.contractHash,
  });
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
        throw parseRustraErrorString(response.error);
      }
      return response.result as T;
    },
  };
}

// ── Native module 접근 ─────────────────────────────────────

// ReactLynx 번들 래퍼(@lynx-js/runtime-wrapper-webpack-plugin)가 클로저 변수로
// 주입하는 NativeModules. lynx_core.js / 네이티브 런타임은 globalThis.NativeModules
// 를 설정하지 않는다 — NativeModules 는 번들 외곽 함수의 위치 인자로 주입되며,
// 번들 내 모든 모듈의 bare 식별자가 이 클로저 변수로 해석된다
// (@lynx-js/websocket 의 NativeModules.LynxWebSocketModule 과 동일 패턴).
// 비-Lynx 환경(Node 테스트, 웹)에서는 존재하지 않으므로 typeof 가드가 필요하다.
declare const NativeModules: Record<string, RustraLynxNative> | undefined;

/**
 * Lynx `NativeModules.RustraModule`에서 네이티브 모듈을 가져온다.
 *
 * iOS/Android 공식 SDK 에서는 ReactLynx 번들 래퍼가 주입한 bare 클로저 변수
 * `NativeModules` 를 읽는다 (lynx_core.js 는 globalThis.NativeModules 를 설정하지
 * 않는다). 데스크톱 헤드리스 호스트(host.cpp)는 globalThis.NativeModules 로 직접
 * 주입하므로, 그 경로로 폴백한다.
 *
 * @example
 * ```ts
 * import { getRustraNative, createFastEngine, configure } from '@rustra/lynx';
 * configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: registry }));
 * ```
 */
export function getRustraNative(): RustraLynxNative {
  // 1순위: ReactLynx BTS 클로저 변수 (iOS/Android 공식 SDK).
  try {
    if (typeof NativeModules !== 'undefined' && NativeModules) {
      const native = NativeModules.RustraModule;
      if (native) return native;
    }
  } catch {
    // NativeModules 접근 중 예외 — 다음 경로로 폴백
  }

  // 2순위: 데스크톱 헤드리스 호스트(host.cpp) 가 globalThis.NativeModules 로
  // 직접 주입한 경로. 공식 SDK 에서는 사용되지 않는다 (Node 테스트도 이 경로 사용).
  const nativeModules = (globalThis as Record<string, unknown>).NativeModules as
    Record<string, RustraLynxNative> | undefined;
  const fallback = nativeModules?.RustraModule;
  if (!fallback) {
    throw new Error(
      'Lynx NativeModules.RustraModule not registered. Register the native module via [globalConfig register_module:] (iOS) or your Lynx module setup (Android).',
    );
  }
  return fallback;
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
