import {
  addNumbersCodec,
  clampCodec,
  createItemCodec,
  divideCodec,
  greetCodec,
  isEvenCodec,
  multiplyCodec,
  processItemCodec,
  rustraRegistryDemoCodec,
  secureComputeCodec,
  sumListCodec,
  toUpperCodec,
} from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  ['addNumbers', addNumbersCodec],
  ['clamp', clampCodec],
  ['createItem', createItemCodec],
  ['divide', divideCodec],
  ['greet', greetCodec],
  ['isEven', isEvenCodec],
  ['multiply', multiplyCodec],
  ['processItem', processItemCodec],
  ['rustraRegistryDemo', rustraRegistryDemoCodec],
  ['secureCompute', secureComputeCodec],
  ['sumList', sumListCodec],
  ['toUpper', toUpperCodec],
]);
