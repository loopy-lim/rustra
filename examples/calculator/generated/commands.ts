import type { AddNumbersInput, AddNumbersOutput, EngineClient } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}

