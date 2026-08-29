import { RustraCommandError } from './errors.js';
import type { EngineClient, InvokeOptions } from './public.js';

export function invokeByIdWithTimeout<T>(
  engine: EngineClient,
  commandId: number,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted)
    return Promise.reject(
      new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
    );
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(engine.invokeById!<T>(commandId, command, args, options));
  } catch (error) {
    return Promise.reject(error);
  }
  const ms = options?.timeoutMs;
  if (ms === undefined && signal === undefined) return promise;
  void promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const races: Array<Promise<T> | Promise<never>> = [promise];
  if (signal) {
    races.push(
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  if (ms !== undefined) {
    races.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RustraCommandError(
                'transport.timeout',
                `invoke("${command}") timed out after ${ms}ms`,
                true,
              ),
            ),
          ms,
        );
      }),
    );
  }
  return Promise.race(races).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}
