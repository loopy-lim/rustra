// ── rustra generated ────────────────────────────────────────
// File:   positional-facade.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → positional facade
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

// 정적 명령을 positional 시그니처로 노출해 JSI invokeTyped 를 직접 호출한다.
// 미지원 명령은 이 파일에 없다 — commands.ts 의 global invoke(Tier 3 폴백 포함) 사용.

import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
/** JSI 네이티브 모듈의 최소 인터페이스 — invokeTypedPos 노출 호스트 권장. */
export type PositionalNative = {
  invokeTyped(name: string, args: unknown): unknown;
  /** (P0-3) cmd_id 진입 — 문자열 마샬링을 건너뛴다. 미노출이면 이름 기반으로 폴백. */
  invokeTypedById?(cmdId: number, args: unknown): unknown;
  /** (Tier 1) positional 진입 — JS 인자 객체 생성/프로퍼티 조회를 통째로 건너뛴다. */
  invokeTypedPos?(cmdId: number, ...fields: unknown[]): unknown;
};

let _native: PositionalNative | null = null;

/** 앱 시작 시 JSI 네이티브를 주입한다 (installRustraJSI 이후). */
export function installRustraPositional(native: PositionalNative): void {
  _native = native;
}

function requireNative(): PositionalNative {
  if (!_native) {
    throw new Error('positional facade not installed — call installRustraPositional(native) first');
  }
  return _native;
}

/** byId 진입(우선) — 미노출 구 네이티브는 이름 기반 invokeTyped 로 폴백. */
async function call<T>(cmdId: number, name: string, args: unknown): Promise<T> {
  const native = requireNative();
  if (native.invokeTypedById) {
    return native.invokeTypedById(cmdId, args) as T;
  }
  return native.invokeTyped(name, args) as T;
}

/** (Tier 1) positional 진입 — 개별 인자를 그대로 넘긴다(객체 생성 0). */
async function callPos<T>(cmdId: number, ...fields: unknown[]): Promise<T> {
  const native = requireNative();
  if (native.invokeTypedPos) {
    return native.invokeTypedPos(cmdId, ...fields) as T;
  }
  // 구 네이티브 폴백: 필드 순서는 스키마 프로퍼티 순(생성 시점 필드 리스트)과 동일.
  throw new Error(
    'positional entry unavailable — update the native module (invokeTypedPos)',
  );
}

export function addNumbers(a: number | bigint, b: number | bigint): Promise<AddNumbersOutput> {
  return callPos<AddNumbersOutput>(1, a, b);
}

export function benchAdd(a: number, b: number): Promise<BenchAddOutput> {
  return callPos<BenchAddOutput>(23, a, b);
}

export function benchEchoBytes(data: Uint8Array | ArrayBuffer): Promise<BenchBytesPayload> {
  return callPos<BenchBytesPayload>(25, data);
}

export function benchEchoPair(name: string, value: number): Promise<BenchPairPayload> {
  return callPos<BenchPairPayload>(26, name, value);
}

export function benchEchoString(value: string): Promise<BenchStringPayload> {
  return callPos<BenchStringPayload>(24, value);
}

export function channelDemo(channel: number | bigint, ticks: number): Promise<ChannelDemoOutput> {
  return callPos<ChannelDemoOutput>(18, channel, ticks);
}

export function clamp(max: number, min: number, value: number): Promise<ClampOutput> {
  return callPos<ClampOutput>(4, max, min, value);
}

export function createItem(name: string, value: number | bigint): Promise<CreateItemOutput> {
  return callPos<CreateItemOutput>(8, name, value);
}

export function divide(a: number | bigint, b: number | bigint): Promise<DivideOutput> {
  return callPos<DivideOutput>(10, a, b);
}

export function emitDemo(ticks: number | bigint, stepDelayMs: number | bigint): Promise<EmitDemoOutput> {
  return callPos<EmitDemoOutput>(11, ticks, stepDelayMs);
}

export function gauge(limit: number | bigint, offset: number | bigint): Promise<GaugeOutput> {
  return callPos<GaugeOutput>(17, limit, offset);
}

export function greet(name: string): Promise<GreetOutput> {
  return callPos<GreetOutput>(5, name);
}

export function isEven(n: number | bigint): Promise<IsEvenOutput> {
  return callPos<IsEvenOutput>(3, n);
}

export function multiply(a: number, b: number): Promise<MultiplyOutput> {
  return callPos<MultiplyOutput>(2, a, b);
}

export function processItem(input: ProcessItemInput): Promise<ProcessItemOutput> {
  return call<ProcessItemOutput>(9, 'processItem', input);
}

export function resourceClose(handle: number | bigint): Promise<ResourceCloseOutput> {
  return callPos<ResourceCloseOutput>(22, handle);
}

export function resourceOpen(input: ResourceOpenInput): Promise<ResourceHandleOutput> {
  return call<ResourceHandleOutput>(19, 'resourceOpen', input);
}

export function resourceRead(handle: number | bigint, key: string): Promise<ResourceReadOutput> {
  return callPos<ResourceReadOutput>(20, handle, key);
}

export function resourceWrite(handle: number | bigint, key: string, value: string): Promise<ResourceWriteOutput> {
  return callPos<ResourceWriteOutput>(21, handle, key, value);
}

export function rustraRegistryDemo(op: string): Promise<RegistryDemoOutput> {
  return callPos<RegistryDemoOutput>(12, op);
}

export function scoreTotal(input: ScoreTotalInput): Promise<ScoreTotalOutput> {
  return call<ScoreTotalOutput>(15, 'scoreTotal', input);
}

export function secureCompute(a: number | bigint, b: number | bigint): Promise<SecureComputeOutput> {
  return callPos<SecureComputeOutput>(13, a, b);
}

export function sizeOf(data: Uint8Array | ArrayBuffer): Promise<SizeOfOutput> {
  return callPos<SizeOfOutput>(14, data);
}

export function span(input: SpanInput): Promise<SpanOutput> {
  return call<SpanOutput>(16, 'span', input);
}

export function sumList(input: SumListInput): Promise<SumListOutput> {
  return call<SumListOutput>(6, 'sumList', input);
}

export function toUpper(s: string): Promise<ToUpperOutput> {
  return callPos<ToUpperOutput>(7, s);
}

export function wideAgg(input: WideAggInput): Promise<WideAggOutput> {
  return call<WideAggOutput>(28, 'wideAgg', input);
}
