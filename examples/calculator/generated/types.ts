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
