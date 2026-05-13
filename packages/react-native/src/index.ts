export type ReactNativeRustraModule = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createReactNativeEngine(
  nativeModule: ReactNativeRustraModule,
): ReactNativeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await nativeModule.invoke(command, args)) as T;
    },
  };
}
