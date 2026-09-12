// ── rustra generated ────────────────────────────────────────
// File:   frame-registry.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts codec renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { adminStatsCodec, grantCodec, signInCodec, signOutCodec } from './frame-codecs.js';

export const frameRegistry = new Map<string, import('@rustra/types').FrameCodec<any, any>>([
  // route: postcard
  ['adminStats', adminStatsCodec],
  // route: postcard
  ['grant', grantCodec],
  // route: postcard
  ['signIn', signInCodec],
  // route: postcard
  ['signOut', signOutCodec],
]);
