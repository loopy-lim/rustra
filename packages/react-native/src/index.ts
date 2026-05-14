/**
 * @rustra/react-native — React Native용 rustra 엔진 어댑터
 *
 * Tauri-like 글로벌 invoke 패턴을 제공합니다.
 * `configure()`로 한 번 설정하면, 생성된 명령 함수를 engine 없이 직접 호출할 수 있습니다.
 *
 * ## 설정 (앱 시작 시 한 번)
 *
 * ```ts
 * import { configure } from '@rustra/react-native';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 * import { installRustraJSI, getRustraNative } from './modules/rustra-jsi/src';
 *
 * await installRustraJSI();
 * configure(getRustraNative(), rkyvV2Registry);
 * ```
 *
 * ## 사용 (어디서든)
 *
 * ```ts
 * import { addNumbers } from './generated/commands.js';
 * const result = await addNumbers({ a: 20, b: 22 }); // { value: 42 }
 * ```
 */

// ── Types ───────────────────────────────────────────────────

export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

export type RkyvV2Codec<I, O> = {
  commandId: number;
  encode(args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: string };
};

export type RustraJSINative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
};

export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

// ── Global state ────────────────────────────────────────────

let _engine: EngineClient | null = null;

/**
 * 글로벌 엔진을 설정합니다. 앱 시작 시 한 번만 호출합니다.
 *
 * @param native - `invokeRkyvV2` 메서드가 있는 JSI 네이티브 모듈
 * @param registry - 명령 이름 → 코덱 매핑 (`rkyv-registry.ts`에서 자동 생성)
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/react-native';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * await installRustraJSI();
 * configure(getRustraNative(), rkyvV2Registry);
 * ```
 */
export function configure(
  native: RkyvV2Native,
  registry: Map<string, RkyvV2Codec<any, any>>,
): void {
  _engine = createRkyvV2Engine(native, registry);
}

/**
 * 글로벌 엔진으로 명령을 호출합니다.
 *
 * `configure()`로 설정된 엔진을 사용합니다.
 * 일반적으로 직접 호출하지 않고, 코드젠이 생성한 명령 함수(`addNumbers` 등)를 사용합니다.
 *
 * @example
 * ```ts
 * // 직접 호출
 * const result = await invoke<AddNumbersOutput>('addNumbers', { a: 42, b: 58 });
 *
 * // 또는 생성된 함수 사용 (권장)
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */
export function invoke<T>(command: string, args?: unknown): Promise<T> {
  if (!_engine) {
    throw new Error(
      'Rustra not configured. Call configure(native, registry) first.',
    );
  }
  return _engine.invoke<T>(command, args);
}

// ── Engine factories ────────────────────────────────────────

export function createRkyvV2Engine(
  native: RkyvV2Native,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`RkyvV2: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokeRkyvV2(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error ?? 'RkyvV2 invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}

export function createReactNativeEngine(native: RustraJSINative): EngineClient {
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
