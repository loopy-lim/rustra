/**
 * @rustra/types — rustra 브릿지의 핵심 타입 정의
 *
 * 모든 플랫폼 어댑터(Node, Bun, Tauri, React Native)가 공유하는
 * EngineClient 인터페이스와 에러 타입을 제공합니다.
 *
 * @example
 * ```ts
 * import type { EngineClient, RustraError } from '@rustra/types';
 * import { RustraCommandError } from '@rustra/types';
 * ```
 */

/**
 * 모든 플랫폼 어댑터가 구현해야 하는 공통 인터페이스입니다.
 *
 * 생성된 TypeScript 커맨드 헬퍼 함수는 이 인터페이스에 의존하며,
 * 플랫폼별 어댑터가 실제 transport를 주입합니다.
 *
 * @example
 * ```ts
 * const engine: EngineClient = createNodeEngine({ invoke: myTransport });
 * const result = await engine.invoke<AddNumbersOutput>('addNumbers', { a: 1, b: 2 });
 * ```
 */
export type EngineClient = {
  /**
   * 명령을 호출합니다.
   *
   * @param command - 등록된 명령 이름 (예: "addNumbers")
   * @param args - 명령 입력 인자 (선택적)
   * @returns 명령의 출력 결과
   */
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

/**
 * Rust 측에서 전달되는 에러의 구조입니다.
 *
 * `code`는 에러 분류 문자열이며, `message`는 사람이 읽을 수 있는 설명입니다.
 *
 * @example
 * ```ts
 * // Rust: RustraError::custom("validation.too_large", "value exceeds limit")
 * const error: RustraError = { code: "validation.too_large", message: "value exceeds limit" };
 * ```
 */
export type RustraError = {
  /** 에러 분류 코드 (예: "command.not_found", "internal") */
  readonly code: string;
  /** 사람이 읽을 수 있는 에러 메시지 */
  readonly message: string;
};

/**
 * rustra 명령 실행 중 발생한 에러를 나타내는 Error 서브클래스입니다.
 *
 * 플랫폼 어댑터 내부에서 transport 에러를 이 타입으로 래핑합니다.
 * `instanceof` 검사로 rustra 에러를 구분할 수 있습니다.
 *
 * @example
 * ```ts
 * try {
 *   const result = await addNumbers(engine, { a: 1, b: 2 });
 * } catch (e) {
 *   if (e instanceof RustraCommandError) {
 *     console.log(e.code, e.message); // "command.not_found" "command not found: multiply"
 *   }
 * }
 * ```
 */
export class RustraCommandError extends Error {
  /** 에러 분류 코드 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RustraCommandError';
    this.code = code;
  }
}
