import { RustraCommandError } from '@rustra/types';

/**
 * @rustra/react-native — React Native용 rustra 엔진 어댑터
 *
 * React Native 환경에서 rustra 명령을 실행할 수 있는 EngineClient 구현체를 제공합니다.
 * JSI(Javascript Interface)를 통해 네이티브 모듈과 통신하며,
 * 직렬화에 ArrayBuffer 기반 JSON 인코딩을 사용합니다.
 *
 * ## 설정
 *
 * 네이티브 모듈이 {@link RustraJSINative} 인터페이스를 구현해야 합니다.
 * Turbo Module 또는 Expo Module로 구현할 수 있습니다.
 *
 * @example
 * ```ts
 * import { createReactNativeEngine } from '@rustra/react-native';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createReactNativeEngine(RustraCalculatorModule);
 * const result = await addNumbers(engine, { a: 20, b: 22 }); // 42
 * ```
 */

/**
 * React Native 네이티브 모듈이 구현해야 하는 JSI 인터페이스입니다.
 *
 * 입력으로 JSON 문자열이 인코딩된 ArrayBuffer를 받고,
 * 결과도 ArrayBuffer로 반환합니다. 네이티브 측에서 Rust FFI를 통해
 * 명령을 실행하고 결과를 반환합니다.
 */
export type RustraJSINative = {
  /**
   * ArrayBuffer 형태의 JSON 페이로드를 전송하여 명령을 실행합니다.
   *
   * @param payload - `{ command: string, args: unknown }` 형태의 JSON이 인코딩된 ArrayBuffer
   * @returns `{ ok: boolean, result?: T, error?: string }` 형태의 JSON이 인코딩된 ArrayBuffer
   */
  invoke(payload: ArrayBuffer): ArrayBuffer;
};

/**
 * React Native EngineClient의 타입 정의입니다.
 *
 * {@link EngineClient}과 동일한 시그니처를 가집니다.
 */
export type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

/**
 * React Native JSI 네이티브 모듈로 EngineClient을 생성합니다.
 *
 * 명령 호출 시 `{ command, args }`를 JSON으로 직렬화하여 ArrayBuffer로 네이티브에 전달하고,
 * 응답을 `{ ok, result, error }` 형태로 파싱합니다.
 *
 * 동기 JSI 호출을 사용하므로 Promise.resolve로 래핑하여 비동기 인터페이스를 제공합니다.
 *
 * @param native - JSI 네이티브 모듈 구현체
 * @returns EngineClient 인터페이스를 충족하는 엔진
 *
 * @example
 * ```ts
 * const engine = createReactNativeEngine(NativeModules.RustraCalculator);
 * ```
 */
export function createReactNativeEngine(
  native: RustraJSINative,
): ReactNativeEngineClient {
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
        const err = new RustraCommandError(
          response.error ?? 'Rustra invoke failed',
          response.error ?? 'unknown',
        );
        throw err;
      }
      return Promise.resolve(response.result as T);
    },
  };
}
