export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type RustraError = {
  readonly code: string;
  readonly message: string;
};

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};

