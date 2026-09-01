// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { AdminStatsInput, AdminStatsOutput, GrantInput, GrantOutput, SignInInput, SignInOutput, SignOutInput, SignOutOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedFields1 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function adminStats(input: AdminStatsInput, options?: InvokeOptions): Promise<AdminStatsOutput> {
  return invokeGeneratedFields1<AdminStatsOutput>(4, 'adminStats', input, input["token"], options);
}
adminStats.commandId = 'adminStats';

export const grant = createGeneratedFields2<GrantInput, GrantOutput>(3, 'grant', "token", "capability", 'grant');

export const signIn = createGeneratedFields2<SignInInput, SignInOutput>(1, 'signIn', "username", "password", 'signIn');

export function signOut(input: SignOutInput, options?: InvokeOptions): Promise<SignOutOutput> {
  return invokeGeneratedFields1<SignOutOutput>(2, 'signOut', input, input["token"], options);
}
signOut.commandId = 'signOut';
