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

export type {
  EngineClient,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  InvokeOptions,
} from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';
import { parseRustraErrorString, RustraCommandError, type InvokeOptions } from '@rustra/types';

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
    async invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      // signal 정책(전 어댑터 공통): abort 된 signal 만 cancelled 로 거부하고,
      // 미abort signal 은 정상 실행한다(얕은 취소 — 실행 중 abort 는 결과를 무시할
      // 뿐). useCommand 처럼 항상 signal 을 전달하는 호출부와의 호환을 위해 signal
      // 존재 자체를 에러로 삼지 않는다 — 매트릭스(docs/compatibility-matrix.md) 참고.
      if (options?.signal?.aborted) {
        throw new RustraCommandError(
          'cancelled',
          `invoke("${command}") aborted before dispatch`,
          true,
        );
      }
      try {
        return (await transport.invoke(command, args)) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        // Rust 와이어 에러 — reason 이 RustraError JSON 또는 "code: message"
        // Display 문자열인 경우 parseRustraErrorString 이 code/retryable 을
        // 복원한다. @rustra/node 와 동일 파이프라인(unknown 래핑 방지).
        if (e instanceof Error) {
          throw parseRustraErrorString(e.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}
