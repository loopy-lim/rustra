// ── rustra generated ────────────────────────────────────────
// File:   rkyv-registry.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts codec renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { adminStatsCodec, grantCodec, signInCodec, signOutCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  // route: postcard
  ['adminStats', adminStatsCodec],
  // route: postcard
  ['grant', grantCodec],
  // route: postcard
  ['signIn', signInCodec],
  // route: postcard
  ['signOut', signOutCodec],
]);
