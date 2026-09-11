// ── rustra generated ────────────────────────────────────────
// File:   bun.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → host entry
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { createBunBootstrap } from '@rustra/bun';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './contract.js';
import { frameRegistry } from './frame-registry.js';

export * from './commands.js';

const targetDirectory = new URL("../../../target/", import.meta.url);
const library = `${process.platform === 'win32' ? '' : 'lib'}rustra_calculator_example.${suffix}`;

export const rustra = createBunBootstrap({
  libraryName: "rustra_calculator_example",
  libraryCandidates: [
    fileURLToPath(new URL(`release/${library}`, targetDirectory)),
    fileURLToPath(new URL(`debug/${library}`, targetDirectory)),
  ],
  frameCodecs: frameRegistry,
  contractHash: GENERATED_CONTRACT_HASH,
  contractVerification: 'strict',
  schemaVersion: SCHEMA_VERSION,
});
