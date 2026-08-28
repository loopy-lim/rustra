import { addNumbersComplexCodec, benchAddCodec, benchEchoBytesCodec, benchEchoPairCodec, benchEchoStringCodec, channelDemoCodec, clampCodec, createItemComplexCodec, divideComplexCodec, emitDemoComplexCodec, gaugeComplexCodec, greetCodec, isEvenComplexCodec, multiplyCodec, processItemComplexCodec, resourceCloseCodec, resourceOpenCodec, resourceReadCodec, resourceWriteCodec, rustraRegistryDemoCodec, scoreTotalComplexCodec, secureComputeComplexCodec, sizeOfCodec, spanComplexCodec, sumListComplexCodec, toUpperCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  // route: complex
  ['addNumbers', addNumbersComplexCodec],
  // route: postcard
  ['benchAdd', benchAddCodec],
  // route: postcard
  ['benchEchoBytes', benchEchoBytesCodec],
  // route: postcard
  ['benchEchoPair', benchEchoPairCodec],
  // route: postcard
  ['benchEchoString', benchEchoStringCodec],
  // route: postcard
  ['channelDemo', channelDemoCodec],
  // route: postcard
  ['clamp', clampCodec],
  // route: complex
  ['createItem', createItemComplexCodec],
  // route: complex
  ['divide', divideComplexCodec],
  // route: complex
  ['emitDemo', emitDemoComplexCodec],
  // route: complex
  ['gauge', gaugeComplexCodec],
  // route: postcard
  ['greet', greetCodec],
  // route: complex
  ['isEven', isEvenComplexCodec],
  // route: postcard
  ['multiply', multiplyCodec],
  // route: complex
  ['processItem', processItemComplexCodec],
  // route: postcard
  ['resourceClose', resourceCloseCodec],
  // route: postcard
  ['resourceOpen', resourceOpenCodec],
  // route: postcard
  ['resourceRead', resourceReadCodec],
  // route: postcard
  ['resourceWrite', resourceWriteCodec],
  // route: postcard
  ['rustraRegistryDemo', rustraRegistryDemoCodec],
  // route: complex
  ['scoreTotal', scoreTotalComplexCodec],
  // route: complex
  ['secureCompute', secureComputeComplexCodec],
  // route: postcard
  ['sizeOf', sizeOfCodec],
  // route: complex
  ['span', spanComplexCodec],
  // route: complex
  ['sumList', sumListComplexCodec],
  // route: postcard
  ['toUpper', toUpperCodec],
]);
