export type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type BunEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createBunEngine(transport: BunInvokeTransport): BunEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
