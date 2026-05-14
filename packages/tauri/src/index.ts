export type RustraError = {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
};

export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export type TauriEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export class RustraCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RustraCommandError';
    this.code = code;
  }
}

export function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}
