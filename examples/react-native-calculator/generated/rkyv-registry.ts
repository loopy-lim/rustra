import { addNumbersCodec, benchAddCodec, benchEchoBytesCodec, benchEchoPairCodec, benchEchoStringCodec, channelDemoCodec, clampCodec, createItemCodec, divideCodec, echoGroupsComplexCodec, emitDemoCodec, gaugeCodec, greetCodec, isEvenCodec, multiplyCodec, processItemCodec, resourceCloseCodec, resourceOpenCodec, resourceReadCodec, resourceWriteCodec, rustraRegistryDemoCodec, scoreTotalCodec, secureComputeCodec, sizeOfCodec, spanCodec, sumListCodec, tagSetComplexCodec, toUpperCodec, wideAggCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  // route: postcard
  ['addNumbers', addNumbersCodec],
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
  // route: postcard
  ['createItem', createItemCodec],
  // route: postcard
  ['divide', divideCodec],
  // route: complex
  ['echoGroups', echoGroupsComplexCodec],
  // route: postcard
  ['emitDemo', emitDemoCodec],
  // route: postcard
  ['gauge', gaugeCodec],
  // route: postcard
  ['greet', greetCodec],
  // route: postcard
  ['isEven', isEvenCodec],
  // route: postcard
  ['multiply', multiplyCodec],
  // route: postcard
  ['processItem', processItemCodec],
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
  // route: postcard
  ['scoreTotal', scoreTotalCodec],
  // route: postcard
  ['secureCompute', secureComputeCodec],
  // route: postcard
  ['sizeOf', sizeOfCodec],
  // route: postcard
  ['span', spanCodec],
  // route: postcard
  ['sumList', sumListCodec],
  // route: complex
  ['tagSet', tagSetComplexCodec],
  // route: postcard
  ['toUpper', toUpperCodec],
  // route: postcard
  ['wideAgg', wideAggCodec],
]);
