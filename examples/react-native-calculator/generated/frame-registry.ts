// ── rustra generated ────────────────────────────────────────
// File:   frame-registry.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts codec renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { addCodec, addNumbersCodec, benchAddCodec, benchEchoBytesCodec, benchEchoPairCodec, benchEchoStringCodec, channelDemoCodec, channelDemoBytesCodec, clampCodec, createItemCodec, deviceDemoComplexCodec, divideCodec, echoGroupsComplexCodec, emitDemoCodec, gaugeCodec, greetCodec, greetPersonCodec, isEvenCodec, kindEchoComplexCodec, multiplyCodec, parityEchoCodec, parityFindCodec, parityIndexedCodec, parityResidentCodec, parityStoreCodec, platformNativeInfoComplexCodec, processItemCodec, readRememberedComplexCodec, rememberComplexCodec, resetComplexCodec, resourceCloseCodec, resourceOpenCodec, resourceReadCodec, resourceWriteCodec, rustraRegistryDemoCodec, safeDivideCodec, scoreTotalCodec, secureComputeCodec, sizeOfCodec, spanCodec, sumListCodec, tagSetComplexCodec, toUpperCodec, wideAggCodec } from './frame-codecs.js';

export const frameRegistry = new Map<string, import('@rustra/types').FrameCodec<any, any>>([
  // route: postcard
  ['add', addCodec],
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
  ['channelDemoBytes', channelDemoBytesCodec],
  // route: postcard
  ['clamp', clampCodec],
  // route: postcard
  ['createItem', createItemCodec],
  // route: complex
  ['deviceDemo', deviceDemoComplexCodec],
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
  ['greetPerson', greetPersonCodec],
  // route: postcard
  ['isEven', isEvenCodec],
  // route: complex
  ['kindEcho', kindEchoComplexCodec],
  // route: postcard
  ['multiply', multiplyCodec],
  // route: postcard
  ['parityEcho', parityEchoCodec],
  // route: postcard
  ['parityFind', parityFindCodec],
  // route: postcard
  ['parityIndexed', parityIndexedCodec],
  // route: postcard
  ['parityResident', parityResidentCodec],
  // route: postcard
  ['parityStore', parityStoreCodec],
  // route: complex
  ['platformNativeInfo', platformNativeInfoComplexCodec],
  // route: postcard
  ['processItem', processItemCodec],
  // route: complex
  ['readRemembered', readRememberedComplexCodec],
  // route: complex
  ['remember', rememberComplexCodec],
  // route: complex
  ['reset', resetComplexCodec],
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
  ['safeDivide', safeDivideCodec],
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
