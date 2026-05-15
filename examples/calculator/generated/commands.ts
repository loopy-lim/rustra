import type {
  AddNumbersInput,
  AddNumbersOutput,
  ClampInput,
  ClampOutput,
  CreateItemInput,
  CreateItemOutput,
  GreetInput,
  GreetOutput,
  IsEvenInput,
  IsEvenOutput,
  MultiplyInput,
  MultiplyOutput,
  ProcessItemInput,
  ProcessItemOutput,
  SumListInput,
  SumListOutput,
  ToUpperInput,
  ToUpperOutput,
} from './types.js';
import { invoke } from '@rustra/types';

export function addNumbers(input: AddNumbersInput): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input);
}

export function clamp(input: ClampInput): Promise<ClampOutput> {
  return invoke<ClampOutput>('clamp', input);
}

export function createItem(input: CreateItemInput): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input);
}

export function greet(input: GreetInput): Promise<GreetOutput> {
  return invoke<GreetOutput>('greet', input);
}

export function isEven(input: IsEvenInput): Promise<IsEvenOutput> {
  return invoke<IsEvenOutput>('isEven', input);
}

export function multiply(input: MultiplyInput): Promise<MultiplyOutput> {
  return invoke<MultiplyOutput>('multiply', input);
}

export function processItem(input: ProcessItemInput): Promise<ProcessItemOutput> {
  return invoke<ProcessItemOutput>('processItem', input);
}

export function sumList(input: SumListInput): Promise<SumListOutput> {
  return invoke<SumListOutput>('sumList', input);
}

export function toUpper(input: ToUpperInput): Promise<ToUpperOutput> {
  return invoke<ToUpperOutput>('toUpper', input);
}
