import type { AdminStatsInput, AdminStatsOutput, GrantInput, GrantOutput, SignInInput, SignInOutput, SignOutInput, SignOutOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function adminStats(input: AdminStatsInput, options?: InvokeOptions): Promise<AdminStatsOutput> {
  return invoke<AdminStatsOutput>('adminStats', input, options);
}
adminStats.commandId = 'adminStats';

export function grant(input: GrantInput, options?: InvokeOptions): Promise<GrantOutput> {
  return invoke<GrantOutput>('grant', input, options);
}
grant.commandId = 'grant';

export function signIn(input: SignInInput, options?: InvokeOptions): Promise<SignInOutput> {
  return invoke<SignInOutput>('signIn', input, options);
}
signIn.commandId = 'signIn';

export function signOut(input: SignOutInput, options?: InvokeOptions): Promise<SignOutOutput> {
  return invoke<SignOutOutput>('signOut', input, options);
}
signOut.commandId = 'signOut';

