export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type NodeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
