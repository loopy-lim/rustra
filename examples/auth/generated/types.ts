export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AdminStatsInput = {
  token: string;
};

export type AdminStatsOutput = {
  sessions: number;
  uptimeMs: number;
  activeUsers: string[];
};

export type GrantInput = {
  token: string;
  capability: string;
};

export type GrantOutput = {
  granted: boolean;
};

export type SignInInput = {
  username: string;
  password: string;
};

export type SignInOutput = {
  token: string;
  role: string;
};

export type SignOutInput = {
  token: string;
};

export type SignOutOutput = {
  signedOut: boolean;
};

