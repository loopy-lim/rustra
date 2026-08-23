import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';
import { invokeGenerated } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<AddNumbersOutput> {
  return invokeGenerated<AddNumbersOutput>(1, 'addNumbers', input, options);
}
addNumbers.commandId = 'addNumbers';

export function benchAdd(input: BenchAddInput, options?: InvokeOptions): Promise<BenchAddOutput> {
  return invokeGenerated<BenchAddOutput>(23, 'benchAdd', input, options);
}
benchAdd.commandId = 'benchAdd';

export function benchEchoBytes(input: BenchBytesPayload, options?: InvokeOptions): Promise<BenchBytesPayload> {
  return invokeGenerated<BenchBytesPayload>(25, 'benchEchoBytes', input, options);
}
benchEchoBytes.commandId = 'benchEchoBytes';

export function benchEchoPair(input: BenchPairPayload, options?: InvokeOptions): Promise<BenchPairPayload> {
  return invokeGenerated<BenchPairPayload>(26, 'benchEchoPair', input, options);
}
benchEchoPair.commandId = 'benchEchoPair';

export function benchEchoString(input: BenchStringPayload, options?: InvokeOptions): Promise<BenchStringPayload> {
  return invokeGenerated<BenchStringPayload>(24, 'benchEchoString', input, options);
}
benchEchoString.commandId = 'benchEchoString';

export function channelDemo(input: ChannelDemoInput, options?: InvokeOptions): Promise<ChannelDemoOutput> {
  return invokeGenerated<ChannelDemoOutput>(18, 'channelDemo', input, options);
}
channelDemo.commandId = 'channelDemo';

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGenerated<ClampOutput>(4, 'clamp', input, options);
}
clamp.commandId = 'clamp';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invokeGenerated<CreateItemOutput>(8, 'createItem', input, options);
}
createItem.commandId = 'createItem';

export function divide(input: DivideInput, options?: InvokeOptions): Promise<DivideOutput> {
  return invokeGenerated<DivideOutput>(10, 'divide', input, options);
}
divide.commandId = 'divide';

export function emitDemo(input: EmitDemoInput, options?: InvokeOptions): Promise<EmitDemoOutput> {
  return invokeGenerated<EmitDemoOutput>(11, 'emitDemo', input, options);
}
emitDemo.commandId = 'emitDemo';

export function gauge(input: GaugeInput, options?: InvokeOptions): Promise<GaugeOutput> {
  return invokeGenerated<GaugeOutput>(17, 'gauge', input, options);
}
gauge.commandId = 'gauge';

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGenerated<GreetOutput>(5, 'greet', input, options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGenerated<IsEvenOutput>(3, 'isEven', input, options);
}
isEven.commandId = 'isEven';

export function multiply(input: MultiplyInput, options?: InvokeOptions): Promise<MultiplyOutput> {
  return invokeGenerated<MultiplyOutput>(2, 'multiply', input, options);
}
multiply.commandId = 'multiply';

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invokeGenerated<ProcessItemOutput>(9, 'processItem', input, options);
}
processItem.commandId = 'processItem';

export function resourceClose(input: ResourceCloseInput, options?: InvokeOptions): Promise<ResourceCloseOutput> {
  return invokeGenerated<ResourceCloseOutput>(22, 'resourceClose', input, options);
}
resourceClose.commandId = 'resourceClose';

export function resourceOpen(input: ResourceOpenInput, options?: InvokeOptions): Promise<ResourceHandleOutput> {
  return invokeGenerated<ResourceHandleOutput>(19, 'resourceOpen', input, options);
}
resourceOpen.commandId = 'resourceOpen';

export function resourceRead(input: ResourceReadInput, options?: InvokeOptions): Promise<ResourceReadOutput> {
  return invokeGenerated<ResourceReadOutput>(20, 'resourceRead', input, options);
}
resourceRead.commandId = 'resourceRead';

export function resourceWrite(input: ResourceWriteInput, options?: InvokeOptions): Promise<ResourceWriteOutput> {
  return invokeGenerated<ResourceWriteOutput>(21, 'resourceWrite', input, options);
}
resourceWrite.commandId = 'resourceWrite';

export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invokeGenerated<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export function secureCompute(input: SecureComputeInput, options?: InvokeOptions): Promise<SecureComputeOutput> {
  return invokeGenerated<SecureComputeOutput>(13, 'secureCompute', input, options);
}
secureCompute.commandId = 'secureCompute';

export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGenerated<SizeOfOutput>(14, 'sizeOf', input, options);
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

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invokeGenerated<ToUpperOutput>(7, 'toUpper', input, options);
}
toUpper.commandId = 'toUpper';

