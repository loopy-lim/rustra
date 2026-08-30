import { normalizeRustraError } from './errors.js';
import { debugRustra } from './debug.js';
import { invokeWithTimeout } from './cancel.js';
import type { BatchEntry, EngineClient, EngineClientWithBatch, InvokeOptions } from './public.js';

/**
 * json-engine 이 이미 아는 와이어 배치 표면 — transport 가 단일 IPC 횡단으로
 * N 개 명령을 실행할 수 있으면 제공한다(트랙 E2). 미제공 시 기존 Promise.all
 * 항목별 폴백으로 동작한다(기존 계약 불변).
 */
export type JsonWireBatchTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
  /** 와이어 배치 — `rustra_dispatch_batch` 커맨드 한 번으로 N 개 명령 실행. */
  invokeBatch?(requests: BatchEntry[]): Promise<unknown[]> | unknown[];
};

export function createJsonEngine(
  transport:
    ((command: string, args?: unknown) => Promise<unknown> | unknown) | JsonWireBatchTransport,
  normalizeArgs: (args?: unknown) => unknown = (args) => args,
): EngineClientWithBatch {
  const rawTransport: JsonWireBatchTransport =
    typeof transport === 'function' ? { invoke: transport } : transport;
  const rawEngine: EngineClient = {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        const normalizedArgs = normalizeArgs(args);
        debugRustra({ direction: 'request', transport: 'json', command, value: normalizedArgs });
        return Promise.resolve(rawTransport.invoke(command, normalizedArgs))
          .then((result) => {
            debugRustra({ direction: 'response', transport: 'json', command, value: result });
            return result as T;
          })
          .catch((error: unknown) => {
            debugRustra({ direction: 'error', transport: 'json', command, error: String(error) });
            throw normalizeRustraError(error);
          }) as Promise<T>;
      } catch (error: unknown) {
        debugRustra({ direction: 'error', transport: 'json', command, error: String(error) });
        return Promise.reject(normalizeRustraError(error));
      }
    },
  };
  return {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      return invokeWithTimeout(rawEngine, command, args, options);
    },
    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      // 와이어 배치(단일 횡단) 경로 — transport 가 지원할 때만. 항목별
      // options(signal/timeoutMs)가 섞이면 항목별 정책을 존중해 폴백한다.
      if (
        typeof rawTransport.invokeBatch === 'function' &&
        !entries.some((entry) => entry.options?.signal || entry.options?.timeoutMs)
      ) {
        return Promise.resolve(rawTransport.invokeBatch(entries)) as Promise<T[]>;
      }
      return Promise.all(
        entries.map((entry) =>
          invokeWithTimeout<T>(rawEngine, entry.command, entry.args, entry.options),
        ),
      );
    },
  };
}
