import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';
import { invokeGenerated, invokeGeneratedFields1, invokeGeneratedFields2, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<AddNumbersOutput> {
  return invokeGeneratedFields2<AddNumbersOutput>(1, 'addNumbers', input, input["a"], input["b"], options);
}
addNumbers.commandId = 'addNumbers';

export function benchAdd(input: BenchAddInput, options?: InvokeOptions): Promise<BenchAddOutput> {
  return invokeGeneratedFields2<BenchAddOutput>(23, 'benchAdd', input, input["a"], input["b"], options);
}
benchAdd.commandId = 'benchAdd';

export function benchEchoBytes(input: BenchBytesPayload, options?: InvokeOptions): Promise<BenchBytesPayload> {
  return invokeGeneratedFields1<BenchBytesPayload>(25, 'benchEchoBytes', input, input["data"], options);
}
benchEchoBytes.commandId = 'benchEchoBytes';

export function benchEchoPair(input: BenchPairPayload, options?: InvokeOptions): Promise<BenchPairPayload> {
  return invokeGeneratedFields2<BenchPairPayload>(26, 'benchEchoPair', input, input["name"], input["value"], options);
}
benchEchoPair.commandId = 'benchEchoPair';

export function benchEchoString(input: BenchStringPayload, options?: InvokeOptions): Promise<BenchStringPayload> {
  return invokeGeneratedFields1<BenchStringPayload>(24, 'benchEchoString', input, input["value"], options);
}
benchEchoString.commandId = 'benchEchoString';

export function channelDemo(input: ChannelDemoInput, options?: InvokeOptions): Promise<ChannelDemoOutput> {
  return invokeGenerated<ChannelDemoOutput>(18, 'channelDemo', input, options);
}
channelDemo.commandId = 'channelDemo';

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invokeGeneratedFields2<CreateItemOutput>(8, 'createItem', input, input["name"], input["value"], options);
}
createItem.commandId = 'createItem';

export function divide(input: DivideInput, options?: InvokeOptions): Promise<DivideOutput> {
  return invokeGeneratedFields2<DivideOutput>(10, 'divide', input, input["a"], input["b"], options);
}
divide.commandId = 'divide';

export function emitDemo(input: EmitDemoInput, options?: InvokeOptions): Promise<EmitDemoOutput> {
  return invokeGeneratedFields2<EmitDemoOutput>(11, 'emitDemo', input, input["ticks"], input["stepDelayMs"], options);
}
emitDemo.commandId = 'emitDemo';

export function gauge(input: GaugeInput, options?: InvokeOptions): Promise<GaugeOutput> {
  return invokeGeneratedFields2<GaugeOutput>(17, 'gauge', input, input["limit"], input["offset"], options);
}
gauge.commandId = 'gauge';

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGeneratedFields1<IsEvenOutput>(3, 'isEven', input, input["n"], options);
}
isEven.commandId = 'isEven';

export function multiply(input: MultiplyInput, options?: InvokeOptions): Promise<MultiplyOutput> {
  return invokeGeneratedFields2<MultiplyOutput>(2, 'multiply', input, input["a"], input["b"], options);
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
  return invokeGeneratedFields1<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, input["op"], options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export function secureCompute(input: SecureComputeInput, options?: InvokeOptions): Promise<SecureComputeOutput> {
  return invokeGeneratedFields2<SecureComputeOutput>(13, 'secureCompute', input, input["a"], input["b"], options);
}
secureCompute.commandId = 'secureCompute';

export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGeneratedFields1<SizeOfOutput>(14, 'sizeOf', input, input["data"], options);
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
  return invokeGeneratedFields1<ToUpperOutput>(7, 'toUpper', input, input["s"], options);
}
toUpper.commandId = 'toUpper';

