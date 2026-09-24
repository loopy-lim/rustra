// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoBytesInput, ChannelDemoBytesOutput, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DeviceDemoOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, KindEchoInput, KindEchoOutput, MultiplyInput, MultiplyOutput, ParityFindInput, ParityQuery, ParitySearch, ParityStored, ParityTree, PlatformNativeInfoOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedBytes, invokeGeneratedFields1, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions as CoreInvokeOptions } from '@rustra/types';

/**
 * 이 패키지 생성 명령의 호출 옵션 — 모든 생성 함수의 마지막 파라미터.
 *
 * ⚠️ **얕은 취소**: `signal` 이 실행 중에 abort 되면 **JS 프라미스만 거부되고**
 * (shallow cancellation) Rust 명령은 끝까지 실행되거나 이미 완료됐을 수 있습니다.
 * 취소/타임아웃은 "명령이 실행되지 않았음"을 보장하지 않습니다.
 *
 * ⚠️ **`retryable: true` ≠ 재실행 안전**: `transport.timeout`·`cancelled` 등
 * retryable 오류는 재시도 시 실패 유형이 사라질 수 있음을 뜻할 뿐, 명령을 다시
 * 실행해도 안전하다는 뜻이 아닙니다. 비멱등 명령의 재시도는 상태를 재조회해 이전
 * 시도가 반영되지 않았음을 확인한 뒤에만 하세요.
 *
 * 전체 의미론은 docs/compatibility-matrix.md "Signal semantics in detail" 및
 * 원본 타입(`InvokeOptions`(@rustra/types)) 문서를 참고하세요.
 */
export type InvokeOptions = CoreInvokeOptions;

// ── 호출 규약 알림 ──────────────────────────────────────────────────
// 이 패키지는 두 호출 규약이 혼재합니다 — 시그니처로 구분하세요:
//   - positional 함수(PackageBuilder::function): 인자를 그대로 나열 — add(1, 2)
//   - struct 기반 명령(#[command]): 필드 객체 하나 — addNumbers({ a: 1, b: 2 })
// ───────────────────────────────────────────────────────────────────

export function add(arg0: number, arg1: number, options?: InvokeOptions): Promise<number> {
  return invokeGenerated<number>(39, 'add', [arg0, arg1], options);
}
add.commandId = 'add';

export const addNumbers = createGeneratedFields2<AddNumbersInput, AddNumbersOutput>(1, 'addNumbers', "a", "b", 'addNumbers');

export const benchAdd = createGeneratedFields2<BenchAddInput, BenchAddOutput>(23, 'benchAdd', "a", "b", 'benchAdd');

export function benchEchoBytes(input: BenchBytesPayload, options?: InvokeOptions): Promise<BenchBytesPayload> {
  return invokeGeneratedBytes<BenchBytesPayload>(25, 'benchEchoBytes', input, input["data"], options);
}
benchEchoBytes.commandId = 'benchEchoBytes';

export const benchEchoPair = createGeneratedFields2<BenchPairPayload, BenchPairPayload>(26, 'benchEchoPair', "name", "value", 'benchEchoPair');

export function benchEchoString(input: BenchStringPayload, options?: InvokeOptions): Promise<BenchStringPayload> {
  return invokeGeneratedFields1<BenchStringPayload>(24, 'benchEchoString', input, input["value"], options);
}
benchEchoString.commandId = 'benchEchoString';

export const channelDemo = createGeneratedFields2<ChannelDemoInput, ChannelDemoOutput>(18, 'channelDemo', "channel", "ticks", 'channelDemo');

/**
 * 바이너리 채널 데모 — `channel_demo` 의 바이트 경로 쌍둥이. 모든 호스트 어댑터의 createBytesChannel/createChannelBytes 패리티를 동일 명령으로 e2e 검증한다(페이로드는 스텝 카운터 LE u64).
 */
export const channelDemoBytes = createGeneratedFields2<ChannelDemoBytesInput, ChannelDemoBytesOutput>(31, 'channelDemoBytes', "channel", "ticks", 'channelDemoBytes');

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(8, 'createItem', "name", "value", 'createItem');

export function deviceDemo(options?: InvokeOptions): Promise<DeviceDemoOutput> {
  return invokeGenerated<DeviceDemoOutput>(32, 'deviceDemo', undefined, options);
}
deviceDemo.commandId = 'deviceDemo';

export const divide = createGeneratedFields2<DivideInput, DivideOutput>(10, 'divide', "a", "b", 'divide');

export function echoGroups(input: EchoGroupsInput, options?: InvokeOptions): Promise<EchoGroupsOutput> {
  return invokeGenerated<EchoGroupsOutput>(27, 'echoGroups', input, options);
}
echoGroups.commandId = 'echoGroups';

export const emitDemo = createGeneratedFields2<EmitDemoInput, EmitDemoOutput>(11, 'emitDemo', "ticks", "stepDelayMs", 'emitDemo');

/**
 * u64/u32 필드 — plain varint(uvar) 와이어 고정(과거 zigzag 버그 수정 증명).
 */
export const gauge = createGeneratedFields2<GaugeInput, GaugeOutput>(17, 'gauge', "limit", "offset", 'gauge');

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);
}
greet.commandId = 'greet';

export function greetPerson(arg0: string, options?: InvokeOptions): Promise<string> {
  return invokeGenerated<string>(40, 'greetPerson', [arg0], options);
}
greetPerson.commandId = 'greetPerson';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGeneratedFields1<IsEvenOutput>(3, 'isEven', input, input["n"], options);
}
isEven.commandId = 'isEven';

export function kindEcho(input: KindEchoInput, options?: InvokeOptions): Promise<KindEchoOutput> {
  return invokeGenerated<KindEchoOutput>(33, 'kindEcho', input, options);
}
kindEcho.commandId = 'kindEcho';

export const multiply = createGeneratedFields2<MultiplyInput, MultiplyOutput>(2, 'multiply', "a", "b", 'multiply');

export function parityEcho(input: ParityTree, options?: InvokeOptions): Promise<ParityTree> {
  return invokeGenerated<ParityTree>(34, 'parityEcho', input, options);
}
parityEcho.commandId = 'parityEcho';

export function parityFind(input: ParityFindInput, options?: InvokeOptions): Promise<ParitySearch> {
  return invokeGenerated<ParitySearch>(35, 'parityFind', input, options);
}
parityFind.commandId = 'parityFind';

export function parityIndexed(input: ParityQuery, options?: InvokeOptions): Promise<ParitySearch> {
  return invokeGeneratedFields1<ParitySearch>(38, 'parityIndexed', input, input["id"], options);
}
parityIndexed.commandId = 'parityIndexed';

export function parityResident(input: ParityQuery, options?: InvokeOptions): Promise<ParitySearch> {
  return invokeGeneratedFields1<ParitySearch>(37, 'parityResident', input, input["id"], options);
}
parityResident.commandId = 'parityResident';

export function parityStore(input: ParityTree, options?: InvokeOptions): Promise<ParityStored> {
  return invokeGenerated<ParityStored>(36, 'parityStore', input, options);
}
parityStore.commandId = 'parityStore';

export function platformNativeInfo(options?: InvokeOptions): Promise<PlatformNativeInfoOutput> {
  return invokeGenerated<PlatformNativeInfoOutput>(30, 'platformNativeInfo', undefined, options);
}
platformNativeInfo.commandId = 'platformNativeInfo';

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invokeGenerated<ProcessItemOutput>(9, 'processItem', input, options);
}
processItem.commandId = 'processItem';

export function readRemembered(options?: InvokeOptions): Promise<number> {
  return invokeGenerated<number>(43, 'readRemembered', null, options);
}
readRemembered.commandId = 'readRemembered';

export function remember(arg0: number, options?: InvokeOptions): Promise<void> {
  return invokeGenerated<void>(42, 'remember', [arg0], options).then(() => undefined);
}
remember.commandId = 'remember';

export function reset(options?: InvokeOptions): Promise<void> {
  return invokeGenerated<void>(44, 'reset', null, options).then(() => undefined);
}
reset.commandId = 'reset';

export function resourceClose(input: ResourceCloseInput, options?: InvokeOptions): Promise<ResourceCloseOutput> {
  return invokeGeneratedFields1<ResourceCloseOutput>(22, 'resourceClose', input, input["handle"], options);
}
resourceClose.commandId = 'resourceClose';

export function resourceOpen(input: ResourceOpenInput, options?: InvokeOptions): Promise<ResourceHandleOutput> {
  return invokeGenerated<ResourceHandleOutput>(19, 'resourceOpen', input, options);
}
resourceOpen.commandId = 'resourceOpen';

export const resourceRead = createGeneratedFields2<ResourceReadInput, ResourceReadOutput>(20, 'resourceRead', "handle", "key", 'resourceRead');

export function resourceWrite(input: ResourceWriteInput, options?: InvokeOptions): Promise<ResourceWriteOutput> {
  return invokeGeneratedFields3<ResourceWriteOutput>(21, 'resourceWrite', input, input["handle"], input["key"], input["value"], options);
}
resourceWrite.commandId = 'resourceWrite';

/**
 * 런타임 registry 제어 명령. op:
 * `register` / `unregister` / `replacePing` / `replaceAdd` / `restoreAdd` / `freeze` / `state`.
 */
export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invokeGeneratedFields1<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, input["op"], options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

export function safeDivide(arg0: number, arg1: number, options?: InvokeOptions): Promise<number> {
  return invokeGenerated<number>(41, 'safeDivide', [arg0, arg1], options);
}
safeDivide.commandId = 'safeDivide';

/**
 * HashMap<String, i64>(동적 맵) — count + (key,value)* 와이어 고정.
 */
export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export const secureCompute = createGeneratedFields2<SecureComputeInput, SecureComputeOutput>(13, 'secureCompute', "a", "b", 'secureCompute');

/**
 * Vec<u8>(postcard bytes) 입력 + u32 출력 — plain varint 와이어 고정.
 */
export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGeneratedBytes<SizeOfOutput>(14, 'sizeOf', input, input["data"], options);
}
sizeOf.commandId = 'sizeOf';

/**
 * (String, i64) 튜플 — i64 때문에 complex-binary count + elements 와이어.
 */
export function span(input: SpanInput, options?: InvokeOptions): Promise<SpanOutput> {
  return invokeGenerated<SpanOutput>(16, 'span', input, options);
}
span.commandId = 'span';

export function sumList(input: SumListInput, options?: InvokeOptions): Promise<SumListOutput> {
  return invokeGenerated<SumListOutput>(6, 'sumList', input, options);
}
sumList.commandId = 'sumList';

export function tagSet(input: TagSetInput, options?: InvokeOptions): Promise<TagSetOutput> {
  return invokeGenerated<TagSetOutput>(29, 'tagSet', input, options);
}
tagSet.commandId = 'tagSet';

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invokeGeneratedFields1<ToUpperOutput>(7, 'toUpper', input, input["s"], options);
}
toUpper.commandId = 'toUpper';

/**
 * A2 와이드 정수 복합 타입 표본 — Vec<u64> + Option<i64>. 원소/옵션 레벨 uvar64/zigzag64 헬퍼가 스트림 중간 7바이트 varint 경계를 넘는 값을 무손실 왕복하는지 cross-wire 픽스처로 고정한다.
 */
export function wideAgg(input: WideAggInput, options?: InvokeOptions): Promise<WideAggOutput> {
  return invokeGenerated<WideAggOutput>(28, 'wideAgg', input, options);
}
wideAgg.commandId = 'wideAgg';
