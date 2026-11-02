import { CancelledError } from './errors.js';

export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  command: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError(`invoke("${command}") aborted`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        // 거절 사유는 항상 Error 계열로 고정한다(non-Error 투기 방지).
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
