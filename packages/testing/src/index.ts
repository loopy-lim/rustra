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

import type { BatchEntry, EngineClient, InvokeOptions } from '@rustra/types';
import { RustraCommandError, resolveCommandId } from '@rustra/types';
import { editDistance, toMockError } from './testing-helpers.js';

type Handler = (args: unknown) => unknown;

export type CommandFunction<I = unknown, O = unknown> =
  | ((input: I, options?: InvokeOptions) => Promise<O>)
  | (((options?: InvokeOptions) => Promise<O>) &
      // 코드젠 산출물이 함수에 심는 minify-안전 식별자 (addNumbers.commandId).
      { commandId?: unknown });

export type MockError =
  RustraCommandError | Error | string | { code: string; message: string; retryable?: boolean };

export type MockEvent = { name: string; payload: unknown };

export type MockEngineOptions = {
  /** Default delay applied to every invocation, useful for cancellation tests. */
  delayMs?: number;
};

export interface MockEngine extends EngineClient {
  /** command 핸들러을 등록하고 엔진 자신을 반환 (체이닝). args 타입은 자유. */
  on<A = unknown>(command: string, handler: (args: A) => unknown): MockEngine;
  /**
   * 생성된 명령 함수를 직접 전달하여 타입 안전하게 mock 핸들러를 등록합니다.
   *
   * @example
   * ```ts
   * const engine = createMockEngine().mock(addNumbers, ({ a, b }) => ({ value: a + b }));
   * ```
   */
  mock<I, O>(commandFn: CommandFunction<I, O>, handler: (args: I) => O | Promise<O>): MockEngine;
  /** 지금까지의 invoke 기록 (command, args, options) — 호출 순서/옵션 검증용. */
  calls(): Array<{ command: string; args: unknown; options?: InvokeOptions }>;
  /**
   * 기록을 비운다. 테스트 케이스 간 격리용 — `calls()` 검증 후 다음 케이스 전에 호출.
   */
  reset(): MockEngine;
  /** 특정 명령에만 인위적인 지연을 적용한다. */
  delay(command: string, delayMs: number): MockEngine;
  /** 특정 명령 호출을 구조화된 Rustra 에러로 실패시킨다. */
  fail(command: string, error: MockError): MockEngine;
  /** Rust 이벤트를 발행하고 구독자에게 전달한다. */
  emit(name: string, payload: unknown): void;
  /** 지금까지 발행된 이벤트를 조회한다. */
  events(): MockEvent[];
  /** 이벤트 구독을 등록하고 해제 함수를 반환한다. */
  subscribeEvent(name: string, handler: (payload: unknown) => void): () => void;
}

export function createMockEngine(mockOptions: MockEngineOptions = {}): MockEngine {
  if (
    mockOptions.delayMs !== undefined &&
    (!Number.isFinite(mockOptions.delayMs) || mockOptions.delayMs < 0)
  ) {
    throw new RangeError('Mock delayMs must be a finite non-negative number');
  }
  const handlers = new Map<string, Handler>();
  const delays = new Map<string, number>();
  const failures = new Map<string, MockError>();
  const log: Array<{ command: string; args: unknown; options?: InvokeOptions }> = [];
  const emitted: MockEvent[] = [];
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  const engine: MockEngine = {
    on(command, handler) {
      handlers.set(command, handler as Handler);
      return engine;
    },
    mock(commandFn, handler) {
      // minify-안전 식별: 코드젠이 심은 commandId 를 우선한다.
      const name = resolveCommandId(commandFn);
      return engine.on(name, handler as (args: unknown) => unknown);
    },
    calls: () => [...log],
    reset() {
      log.length = 0;
      emitted.length = 0;
      return engine;
    },
    delay(command, delayMs) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new RangeError('Mock delay must be a finite non-negative number');
      }
      delays.set(command, delayMs);
      return engine;
    },
    fail(command, error) {
      failures.set(command, error);
      return engine;
    },
    emit(name, payload) {
      emitted.push({ name, payload });
      for (const handler of subscriptions.get(name) ?? []) handler(payload);
    },
    events: () => [...emitted],
    subscribeEvent(name, handler) {
      let handlersForName = subscriptions.get(name);
      if (!handlersForName) {
        handlersForName = new Set();
        subscriptions.set(name, handlersForName);
      }
      handlersForName.add(handler);
      return () => handlersForName!.delete(handler);
    },
    async invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      // pre-aborted signal — 전 어댑터 공통 정책과 동일하게 cancelled 로 거부.
      if (options?.signal?.aborted) {
        throw new RustraCommandError(
          'cancelled',
          `invoke("${command}") aborted before dispatch`,
          true,
        );
      }
      log.push({ command, args, options });
      const effectiveDelay = delays.get(command) ?? mockOptions.delayMs ?? 0;
      if (effectiveDelay !== undefined && effectiveDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, effectiveDelay));
      }
      const configuredFailure = failures.get(command);
      if (configuredFailure !== undefined) throw toMockError(configuredFailure);
      const handler = handlers.get(command);
      if (!handler) {
        const available = [...handlers.keys()].sort();
        const suggestion = available.find((candidate) => editDistance(command, candidate) <= 2);
        throw new RustraCommandError(
          'command.not_found',
          `no mock registered for '${command}'. Available commands: ${available.join(', ') || 'none'}.` +
            (suggestion ? ` Did you mean '${suggestion}'?` : ''),
        );
      }
      try {
        return (await (handler as (args: unknown) => unknown)(args)) as T;
      } catch (e) {
        throw toMockError(e);
      }
    },
    async invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      // 배치는 항목별 invoke 로 라우팅한다(각 항목의 옵션 정책이 그대로 적용되도록).
      return Promise.all(
        entries.map(({ command, args, options }) => engine.invoke<T>(command, args, options)),
      );
    },
  };
  return engine;
}

export {
  assertContractCurrent,
  expectContractCurrent,
  assertContractFieldsCurrent,
  expectContractFieldsCurrent,
  assertContractHashCurrent,
  type ContractFieldDrift,
} from './contract-gate.js';
