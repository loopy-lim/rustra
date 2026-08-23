import type { AdminStatsInput, AdminStatsOutput, GrantInput, GrantOutput, SignInInput, SignInOutput, SignOutInput, SignOutOutput } from './types.js';
import { invokeGenerated } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function adminStats(input: AdminStatsInput, options?: InvokeOptions): Promise<AdminStatsOutput> {
  return invokeGenerated<AdminStatsOutput>(4, 'adminStats', input, options);
}
adminStats.commandId = 'adminStats';

export function grant(input: GrantInput, options?: InvokeOptions): Promise<GrantOutput> {
  return invokeGenerated<GrantOutput>(3, 'grant', input, options);
}
grant.commandId = 'grant';

export function signIn(input: SignInInput, options?: InvokeOptions): Promise<SignInOutput> {
  return invokeGenerated<SignInOutput>(1, 'signIn', input, options);
}
signIn.commandId = 'signIn';

export function signOut(input: SignOutInput, options?: InvokeOptions): Promise<SignOutOutput> {
  return invokeGenerated<SignOutOutput>(2, 'signOut', input, options);
}
signOut.commandId = 'signOut';

