import { normalizeRustraError } from './errors.js';
import { debugRustra } from './debug.js';
import { invokeWithTimeout } from './cancel.js';
import type { BatchEntry, EngineClient, EngineClientWithBatch, InvokeOptions } from './public.js';

export function createJsonEngine(
  transport: (command: string, args?: unknown) => Promise<unknown> | unknown,
  normalizeArgs: (args?: unknown) => unknown = (args) => args,
): EngineClientWithBatch {
  const rawEngine: EngineClient = {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        const normalizedArgs = normalizeArgs(args);
        debugRustra({ direction: 'request', transport: 'json', command, value: normalizedArgs });
        return Promise.resolve(transport(command, normalizedArgs))
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
      return Promise.all(
        entries.map((entry) =>
          invokeWithTimeout<T>(rawEngine, entry.command, entry.args, entry.options),
        ),
      );
    },
  };
}
