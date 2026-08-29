import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedBytes, invokeGeneratedFields1, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

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

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(8, 'createItem', "name", "value", 'createItem');

export const divide = createGeneratedFields2<DivideInput, DivideOutput>(10, 'divide', "a", "b", 'divide');

export function echoGroups(input: EchoGroupsInput, options?: InvokeOptions): Promise<EchoGroupsOutput> {
  return invokeGenerated<EchoGroupsOutput>(27, 'echoGroups', input, options);
}
echoGroups.commandId = 'echoGroups';

export const emitDemo = createGeneratedFields2<EmitDemoInput, EmitDemoOutput>(11, 'emitDemo', "ticks", "stepDelayMs", 'emitDemo');

export const gauge = createGeneratedFields2<GaugeInput, GaugeOutput>(17, 'gauge', "limit", "offset", 'gauge');

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGeneratedFields1<IsEvenOutput>(3, 'isEven', input, input["n"], options);
}
isEven.commandId = 'isEven';

export const multiply = createGeneratedFields2<MultiplyInput, MultiplyOutput>(2, 'multiply', "a", "b", 'multiply');

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invokeGenerated<ProcessItemOutput>(9, 'processItem', input, options);
}
processItem.commandId = 'processItem';

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

export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invokeGeneratedFields1<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, input["op"], options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export const secureCompute = createGeneratedFields2<SecureComputeInput, SecureComputeOutput>(13, 'secureCompute', "a", "b", 'secureCompute');

export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGeneratedBytes<SizeOfOutput>(14, 'sizeOf', input, input["data"], options);
}
sizeOf.commandId = 'sizeOf';

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

