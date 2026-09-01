// ── rustra generated ────────────────────────────────────────
// File:   node.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → host entry
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import { createNodeBootstrap } from '@rustra/node';
import { GENERATED_CONTRACT_HASH } from './contract.js';

export * from './commands.js';

const targetDirectory = new URL("../../../target/", import.meta.url);
const executable = "rustra-calculator-example" + (process.platform === 'win32' ? '.exe' : '');

export const rustra = createNodeBootstrap({
  binaryName: "rustra-calculator-example",
  commandCandidates: [
    fileURLToPath(new URL(`release/${executable}`, targetDirectory)),
    fileURLToPath(new URL(`debug/${executable}`, targetDirectory)),
  ],
  args: ["invoke"],
  contractHash: GENERATED_CONTRACT_HASH,
});
