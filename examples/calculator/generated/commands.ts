import type { AddNumbersInput, AddNumbersOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, SecureComputeInput, SecureComputeOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input, options);
}

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invoke<ClampOutput>('clamp', input, options);
}

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input, options);
}

export function divide(input: DivideInput, options?: InvokeOptions): Promise<DivideOutput> {
  return invoke<DivideOutput>('divide', input, options);
}

export function emitDemo(input: EmitDemoInput, options?: InvokeOptions): Promise<EmitDemoOutput> {
  return invoke<EmitDemoOutput>('emitDemo', input, options);
}

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invoke<GreetOutput>('greet', input, options);
}

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invoke<IsEvenOutput>('isEven', input, options);
}

export function multiply(input: MultiplyInput, options?: InvokeOptions): Promise<MultiplyOutput> {
  return invoke<MultiplyOutput>('multiply', input, options);
}

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invoke<ProcessItemOutput>('processItem', input, options);
}

export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invoke<RegistryDemoOutput>('rustraRegistryDemo', input, options);
}

export function secureCompute(input: SecureComputeInput, options?: InvokeOptions): Promise<SecureComputeOutput> {
  return invoke<SecureComputeOutput>('secureCompute', input, options);
}

export function sumList(input: SumListInput, options?: InvokeOptions): Promise<SumListOutput> {
  return invoke<SumListOutput>('sumList', input, options);
}

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invoke<ToUpperOutput>('toUpper', input, options);
}

