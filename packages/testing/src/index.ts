/**
 * @rustra/testing — rustra 브릿지 테스트 유틸리티.
 *
 * `createMockEngine` 은 Rust 백엔드 없이 생성된 TS 클라이언트를 그대로 구동하는
 * mock `EngineClient` 를 만든다. 핸들러 등록은 `.on(command, handler)` 체이닝으로,
 * 에러는 어댑터 관례와 동일하게 `{code, message}` 를 `RustraCommandError` 로 변환한다.
 *
 * @example
 * ```ts
 * import { createMockEngine } from '@rustra/testing';
 * import { configure } from '@rustra/types';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createMockEngine().on('addNumbers', ({a, b}) => a + b);
 * configure(engine); // 글로벌 invoke 에 설치 — 생성 함수는 파라미터 없이 호출
 * const result = await addNumbers({ a: 20, b: 22 }); // 42
 * ```
 */

import type { EngineClient } from '@rustra/types';
import { RustraCommandError } from '@rustra/types';

type Handler = (args: never) => unknown;

export interface MockEngine extends EngineClient {
  /** command 핸들러을 등록하고 엔진 자신을 반환 (체이닝). args 타입은 자유. */
  on<A = unknown>(command: string, handler: (args: A) => unknown): MockEngine;
  /** 지금까지의 invoke 기록 (command, args) — 호출 순서 검증용. */
  calls(): Array<{ command: string; args: unknown }>;
}

export function createMockEngine(): MockEngine {
  const handlers = new Map<string, Handler>();
  const log: Array<{ command: string; args: unknown }> = [];
  const engine: MockEngine = {
    on(command, handler) {
      handlers.set(command, handler as Handler);
      return engine;
    },
    calls: () => [...log],
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      log.push({ command, args });
      const handler = handlers.get(command);
      if (!handler) {
        throw new RustraCommandError('command.not_found', `no mock registered for '${command}'`);
      }
      try {
        return (await (handler as (args: unknown) => unknown)(args)) as T;
      } catch (e) {
        if (e instanceof RustraCommandError) throw e;
        if (isRustraErrorShape(e)) {
          throw new RustraCommandError(e.code, e.message, e.retryable);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
  return engine;
}

function isRustraErrorShape(
  e: unknown,
): e is { code: string; message: string; retryable?: boolean } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'message' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    typeof (e as { message: unknown }).message === 'string'
  );
}

export { assertContractCurrent } from './contract-gate.js';
