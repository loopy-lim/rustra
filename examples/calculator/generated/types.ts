export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type Item = {
  active: boolean;
  name: string;
  value: number;
};

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};

export type ClampInput = {
  max: number;
  min: number;
  value: number;
};

export type ClampOutput = {
  value: number;
};

export type CreateItemInput = {
  name: string;
  value: number;
};

export type CreateItemOutput = {
  item: Item;
};

export type DivideInput = {
  a: number;
  b: number;
};

export type DivideOutput = {
  value: number;
};

export type EmitDemoInput = {
  /** 발행할 progress.tick 이벤트 수. */
  ticks: number;
  /** 각 스텝 사이 대기 (ms). 데모에서 이벤트 순서를 관찰하기 쉽게. */
  stepDelayMs: number;
};

export type EmitDemoOutput = {
  emitted: number;
};

export type GreetInput = {
  name: string;
};

export type GreetOutput = {
  message: string;
};

export type IsEvenInput = {
  n: number;
};

export type IsEvenOutput = {
  result: boolean;
};

export type MultiplyInput = {
  a: number;
  b: number;
};

export type MultiplyOutput = {
  value: number;
};

export type ProcessItemInput = {
  item: Item;
};

export type ProcessItemOutput = {
  doubled: boolean;
  item: Item;
};

export type RegistryDemoInput = {
  op: string;
};

export type RegistryDemoOutput = {
  ok: boolean;
  frozen: boolean;
  message: string;
};

export type SecureComputeInput = {
  a: number;
  b: number;
};

export type SecureComputeOutput = {
  value: number;
};

export type SumListInput = {
  numbers: number[];
};

export type SumListOutput = {
  count: number;
  total: number;
};

export type ToUpperInput = {
  s: string;
};

export type ToUpperOutput = {
  result: string;
};

