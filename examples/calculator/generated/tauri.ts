// ── rustra generated ────────────────────────────────────────
// File:   tauri.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → host entry
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { createTauriBootstrap } from '@rustra/tauri';

export * from './commands.js';
export { subscribeTauriEvent as subscribeEvent } from '@rustra/tauri';

export const rustra = createTauriBootstrap();
