import type { AddNumbersInput, AddNumbersOutput } from './types.js';
import { invokeGenerated } from '@rustra/types';

export function addNumbers(input: AddNumbersInput): Promise<AddNumbersOutput> {
  return invokeGenerated<AddNumbersOutput>(1, 'addNumbers', input);
}
