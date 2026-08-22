import { addNumbersCodec, clampCodec, createItemCodec, divideCodec, emitDemoCodec, gaugeCodec, greetCodec, isEvenCodec, multiplyCodec, processItemCodec, rustraRegistryDemoCodec, scoreTotalCodec, secureComputeCodec, sizeOfCodec, spanCodec, sumListCodec, toUpperCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  ['addNumbers', addNumbersCodec],
  ['clamp', clampCodec],
  ['createItem', createItemCodec],
  ['divide', divideCodec],
  ['emitDemo', emitDemoCodec],
  ['gauge', gaugeCodec],
  ['greet', greetCodec],
  ['isEven', isEvenCodec],
  ['multiply', multiplyCodec],
  ['processItem', processItemCodec],
  ['rustraRegistryDemo', rustraRegistryDemoCodec],
  ['scoreTotal', scoreTotalCodec],
  ['secureCompute', secureComputeCodec],
  ['sizeOf', sizeOfCodec],
  ['span', spanCodec],
  ['sumList', sumListCodec],
  ['toUpper', toUpperCodec],
]);
