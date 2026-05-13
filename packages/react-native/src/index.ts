export type ReactNativeSyncModule = {
  invokeSync(command: string, args?: unknown): unknown;
};

export type ReactNativeAsyncModule = {
  invoke(command: string, args?: unknown): Promise<unknown>;
};

export type ReactNativeRustraModule = ReactNativeSyncModule & ReactNativeAsyncModule;

export type ReactNativeEngineOptions = {
  mode?: 'sync' | 'async';
};

export type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createReactNativeEngine(
  nativeModule: ReactNativeRustraModule,
  options?: ReactNativeEngineOptions,
): ReactNativeEngineClient {
  const mode = options?.mode ?? 'sync';

  if (mode === 'sync') {
    return {
      invoke<T>(command: string, args?: unknown): Promise<T> {
        return Promise.resolve(nativeModule.invokeSync(command, args) as T);
      },
    };
  }

  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await nativeModule.invoke(command, args)) as T;
    },
  };
}
