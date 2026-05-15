import {
  addNumbersCodec,
  clampCodec,
  createItemCodec,
  greetCodec,
  isEvenCodec,
  multiplyCodec,
  processItemCodec,
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
  ['sumList', sumListCodec],
  ['toUpper', toUpperCodec],
]);
