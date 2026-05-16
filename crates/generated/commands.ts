import type { AddNumbersInput, EngineClient } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<number> {
  return engine.invoke<number>('addNumbers', input);
}

