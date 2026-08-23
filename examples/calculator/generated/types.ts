export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

/**
 * 커맨드 인자로 받은 채널 핸들 — serde 표면은 plain `u32`다.
 * 
 * 코드젠은 이 타입을 인식하면 TS 를 `RustraChannel` 마커 타입으로 발행한다(런타임 값은 여전히 number — wire 는 u32 varint).
 */
export type ChannelHandle = number;

export type Item = {
  active: boolean;
  name: string;
  value: number;
};

/**
 * 커맨드 반환값/필드로 받은 리소스 핸들 — serde 표면은 plain `u32`.
 */
export type ResourceHandle = number;

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};

export type BenchAddInput = {
  a: number;
  b: number;
};

export type BenchAddOutput = {
  value: number;
};

export type BenchBytesPayload = {
  data: Uint8Array | number[];
};

export type BenchPairPayload = {
  name: string;
  value: number;
};

export type BenchStringPayload = {
  value: string;
};

export type ChannelDemoInput = {
  /** 호스트가 발급한 채널 핸들 — JS 콜백이 이 번호에 배선돼 있다. */
  channel: ChannelHandle;
  ticks: number;
};

export type ChannelDemoOutput = {
  sent: number;
  /** 만료된 핸들로의 send 시도 수(stale 무시 계약의 가시화). */
  droppedSends: number;
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

export type GaugeInput = {
  limit: number;
  offset: number;
};

export type GaugeOutput = {
  next: number;
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

export type ResourceCloseInput = {
  handle: ResourceHandle;
};

export type ResourceCloseOutput = {
  closed: boolean;
};

export type ResourceOpenInput = {
  initial: Record<string, string>;
};

export type ResourceHandleOutput = {
  handle: ResourceHandle;
};

export type ResourceReadInput = {
  handle: ResourceHandle;
  key: string;
};

export type ResourceReadOutput = {
  found: boolean;
  value?: string | null;
};

export type ResourceWriteInput = {
  handle: ResourceHandle;
  key: string;
  value: string;
};

export type ResourceWriteOutput = {
  entries: number;
};

export type RegistryDemoInput = {
  op: string;
};

export type RegistryDemoOutput = {
  ok: boolean;
  frozen: boolean;
  message: string;
};

export type ScoreTotalInput = {
  scores: Record<string, number>;
};

export type ScoreTotalOutput = {
  count: number;
  total: number;
};

export type SecureComputeInput = {
  a: number;
  b: number;
};

export type SecureComputeOutput = {
  value: number;
};

export type SizeOfInput = {
  data: Uint8Array | number[];
};

export type SizeOfOutput = {
  checksum: number;
  len: number;
};

export type SpanInput = {
  pair: [string, number];
};

export type SpanOutput = {
  first: string;
  second: number;
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

