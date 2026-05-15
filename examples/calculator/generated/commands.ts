import type { EngineClient, __AddNumbersInput, i64 } from './types.js';

export function addNumbers(engine: EngineClient, input: __AddNumbersInput): Promise<i64> {
  return engine.invoke<i64>('addNumbers', input);
}

