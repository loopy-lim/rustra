import { RustraCommandError } from './errors.js';
import type { EngineClient, InvokeOptions } from './public.js';
export { invokeByIdWithTimeout } from './cancel-by-id.js';
export { raceAbort } from './cancel-abort.js';

export function invokeWithTimeout<T>(
  engine: EngineClient,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  return invokeWithTimeoutInternal(engine, command, args, options, true);
}

export function invokeWithTimeoutHandledSignal<T>(
  engine: EngineClient,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  return invokeWithTimeoutInternal(engine, command, args, options, false);
}

function invokeWithTimeoutInternal<T>(
  engine: EngineClient,
  command: string,
  args: unknown,
  options: InvokeOptions | undefined,
  handleSignal: boolean,
): Promise<T> {
  const signal = handleSignal ? options?.signal : undefined;
  if (signal?.aborted)
    return Promise.reject(
      new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
    );
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(engine.invoke<T>(command, args, options));
  } catch (error) {
    return Promise.reject(error);
  }
  const ms = options?.timeoutMs;
  if (ms === undefined && signal === undefined) return promise;
  void promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const races: Array<Promise<T> | Promise<never>> = [promise];
  if (signal)
    races.push(
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  if (ms !== undefined)
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
  return Promise.race(races).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

export function invokeCallbackWithAbort<T>(
  command: string,
  signal: AbortSignal,
  dispatch: (
    resolve: (value: T) => void,
    reject: (reason: unknown) => void,
    isSettled: () => boolean,
  ) => number | void,
  cancel?: (invocationId: number) => void,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
    );
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let invocationId = -1;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      outcome();
    };
    const onAbort = () =>
      finish(() => {
        if (cancel && invocationId >= 0) cancel(invocationId);
        reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
      });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const id = dispatch(
        (value) => finish(() => resolve(value)),
        (reason) => finish(() => reject(reason)),
        () => settled,
      );
      if (typeof id === 'number') invocationId = id;
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new RustraCommandError(
                'invoke.failed',
                `invoke("${command}") dispatch failed: ${String(error)}`,
              ),
        ),
      );
    }
  });
}
