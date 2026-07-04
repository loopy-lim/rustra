import type { AddNumbersInput, AddNumbersOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, EngineClient, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, RustraError, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}

export function clamp(engine: EngineClient, input: ClampInput): Promise<ClampOutput> {
  return engine.invoke<ClampOutput>('clamp', input);
}

export function createItem(engine: EngineClient, input: CreateItemInput): Promise<CreateItemOutput> {
  return engine.invoke<CreateItemOutput>('createItem', input);
}

export function greet(engine: EngineClient, input: GreetInput): Promise<GreetOutput> {
  return engine.invoke<GreetOutput>('greet', input);
}

export function isEven(engine: EngineClient, input: IsEvenInput): Promise<IsEvenOutput> {
  return engine.invoke<IsEvenOutput>('isEven', input);
}

export function multiply(engine: EngineClient, input: MultiplyInput): Promise<MultiplyOutput> {
  return engine.invoke<MultiplyOutput>('multiply', input);
}

export function processItem(engine: EngineClient, input: ProcessItemInput): Promise<ProcessItemOutput> {
  return engine.invoke<ProcessItemOutput>('processItem', input);
}

export function rustraRegistryDemo(engine: EngineClient, input: RegistryDemoInput): Promise<RegistryDemoOutput> {
  return engine.invoke<RegistryDemoOutput>('rustraRegistryDemo', input);
}

export function sumList(engine: EngineClient, input: SumListInput): Promise<SumListOutput> {
  return engine.invoke<SumListOutput>('sumList', input);
}

export function toUpper(engine: EngineClient, input: ToUpperInput): Promise<ToUpperOutput> {
  return engine.invoke<ToUpperOutput>('toUpper', input);
}

