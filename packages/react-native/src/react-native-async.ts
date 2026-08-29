import type { BatchEntry, EngineClient as EngineClientType, InvokeOptions } from '@rustra/types';
import {
  invokeCallbackWithAbort,
  invokeWithTimeoutHandledSignal,
  parseRustraErrorString,
  RustraCommandError,
} from '@rustra/types';
import {
  createFastEngine,
  type FastEngineOptions,
  type ReactNativeEngine,
  type RustraJSINative,
} from './react-native-core.js';

export type RustraJSIAsyncNative = RustraJSINative & {
  invokeTypedAsync?(
    name: string,
    args: unknown,
    onSuccess: (result: unknown) => void,
    onError: (message: string) => void,
  ): number | void;
  invokeCancel?(invocationId: number): boolean;
};

export function createAsyncEngine(
  native: RustraJSIAsyncNative,
  options: FastEngineOptions,
): ReactNativeEngine {
  const syncEngine = createFastEngine(native, options);
  if (typeof native.invokeTypedAsync !== 'function') {
    console.warn(
      '[rustra/react-native] createAsyncEngine is using the synchronous fallback; rebuild the native module with invokeTypedAsync for JS-thread offload.',
    );
    return syncEngine;
  }
  const invokeTypedAsync = native.invokeTypedAsync.bind(native);
  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      const signal = invokeOptions?.signal;
      if (signal?.aborted)
        return Promise.reject(
          new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
        );
      const dispatch = (
        resolve: (value: T) => void,
        reject: (reason: unknown) => void,
      ): number | void =>
        invokeTypedAsync(
          command,
          args,
          (result) => resolve(result as T),
          (message) => reject(parseRustraErrorString(message)),
        );
      if (!signal) {
        return new Promise<T>((resolve, reject) => {
          void dispatch(resolve, reject);
        });
      }
      return invokeCallbackWithAbort<T>(
        command,
        signal,
        (resolve, reject) => dispatch(resolve, reject),
        typeof native.invokeCancel === 'function' ? (id) => native.invokeCancel!(id) : undefined,
      );
    },
  };
  const engine: ReactNativeEngine = {
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      return invokeWithTimeoutHandledSignal<T>(transport, command, args, invokeOptions);
    },
    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      return Promise.all(
        entries.map((entry) => engine.invoke<T>(entry.command, entry.args, entry.options)),
      );
    },
  };
  return engine;
}
