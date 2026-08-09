import {
  addNumbersCodec,
  clampCodec,
  createItemCodec,
  greetCodec,
  isEvenCodec,
  multiplyCodec,
  processItemCodec,
  rustraRegistryDemoCodec,
  sumListCodec,
  toUpperCodec,
} from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  ['addNumbers', addNumbersCodec],
  ['clamp', clampCodec],
  ['createItem', createItemCodec],
  ['greet', greetCodec],
  ['isEven', isEvenCodec],
  ['multiply', multiplyCodec],
  ['processItem', processItemCodec],
  ['rustraRegistryDemo', rustraRegistryDemoCodec],
  ['sumList', sumListCodec],
  ['toUpper', toUpperCodec],
]);
