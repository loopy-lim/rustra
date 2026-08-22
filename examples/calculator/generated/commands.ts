import type { AddNumbersInput, AddNumbersOutput, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function addNumbers(input: AddNumbersInput, options?: InvokeOptions): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input, options);
}
addNumbers.commandId = 'addNumbers';

export function channelDemo(input: ChannelDemoInput, options?: InvokeOptions): Promise<ChannelDemoOutput> {
  return invoke<ChannelDemoOutput>('channelDemo', input, options);
}
channelDemo.commandId = 'channelDemo';

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invoke<ClampOutput>('clamp', input, options);
}
clamp.commandId = 'clamp';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input, options);
}
createItem.commandId = 'createItem';

export function divide(input: DivideInput, options?: InvokeOptions): Promise<DivideOutput> {
  return invoke<DivideOutput>('divide', input, options);
}
divide.commandId = 'divide';

export function emitDemo(input: EmitDemoInput, options?: InvokeOptions): Promise<EmitDemoOutput> {
  return invoke<EmitDemoOutput>('emitDemo', input, options);
}
emitDemo.commandId = 'emitDemo';

export function gauge(input: GaugeInput, options?: InvokeOptions): Promise<GaugeOutput> {
  return invoke<GaugeOutput>('gauge', input, options);
}
gauge.commandId = 'gauge';

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invoke<GreetOutput>('greet', input, options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invoke<IsEvenOutput>('isEven', input, options);
}
isEven.commandId = 'isEven';

export function multiply(input: MultiplyInput, options?: InvokeOptions): Promise<MultiplyOutput> {
  return invoke<MultiplyOutput>('multiply', input, options);
}
multiply.commandId = 'multiply';

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invoke<ProcessItemOutput>('processItem', input, options);
}
processItem.commandId = 'processItem';

export function resourceClose(input: ResourceCloseInput, options?: InvokeOptions): Promise<ResourceCloseOutput> {
  return invoke<ResourceCloseOutput>('resourceClose', input, options);
}
resourceClose.commandId = 'resourceClose';

export function resourceOpen(input: ResourceOpenInput, options?: InvokeOptions): Promise<ResourceHandleOutput> {
  return invoke<ResourceHandleOutput>('resourceOpen', input, options);
}
resourceOpen.commandId = 'resourceOpen';

export function resourceRead(input: ResourceReadInput, options?: InvokeOptions): Promise<ResourceReadOutput> {
  return invoke<ResourceReadOutput>('resourceRead', input, options);
}
resourceRead.commandId = 'resourceRead';

export function resourceWrite(input: ResourceWriteInput, options?: InvokeOptions): Promise<ResourceWriteOutput> {
  return invoke<ResourceWriteOutput>('resourceWrite', input, options);
}
resourceWrite.commandId = 'resourceWrite';

export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invoke<RegistryDemoOutput>('rustraRegistryDemo', input, options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invoke<ScoreTotalOutput>('scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export function secureCompute(input: SecureComputeInput, options?: InvokeOptions): Promise<SecureComputeOutput> {
  return invoke<SecureComputeOutput>('secureCompute', input, options);
}
secureCompute.commandId = 'secureCompute';

export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invoke<SizeOfOutput>('sizeOf', input, options);
}
sizeOf.commandId = 'sizeOf';

export function span(input: SpanInput, options?: InvokeOptions): Promise<SpanOutput> {
  return invoke<SpanOutput>('span', input, options);
}
span.commandId = 'span';

export function sumList(input: SumListInput, options?: InvokeOptions): Promise<SumListOutput> {
  return invoke<SumListOutput>('sumList', input, options);
}
sumList.commandId = 'sumList';

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invoke<ToUpperOutput>('toUpper', input, options);
}
toUpper.commandId = 'toUpper';

