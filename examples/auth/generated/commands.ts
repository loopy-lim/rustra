import type { AdminStatsInput, AdminStatsOutput, GrantInput, GrantOutput, SignInInput, SignInOutput, SignOutInput, SignOutOutput } from './types.js';
import { invoke } from '@rustra/types';

export function adminStats(input: AdminStatsInput): Promise<AdminStatsOutput> {
  return invoke<AdminStatsOutput>('adminStats', input);
}

export function grant(input: GrantInput): Promise<GrantOutput> {
  return invoke<GrantOutput>('grant', input);
}

export function signIn(input: SignInInput): Promise<SignInOutput> {
  return invoke<SignInOutput>('signIn', input);
}

export function signOut(input: SignOutInput): Promise<SignOutOutput> {
  return invoke<SignOutOutput>('signOut', input);
}

