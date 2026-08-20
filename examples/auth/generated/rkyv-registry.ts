import { adminStatsCodec, grantCodec, signInCodec, signOutCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  ['adminStats', adminStatsCodec],
  ['grant', grantCodec],
  ['signIn', signInCodec],
  ['signOut', signOutCodec],
]);
