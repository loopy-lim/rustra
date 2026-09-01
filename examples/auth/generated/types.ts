// ── rustra generated ────────────────────────────────────────
// File:   types.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AdminStatsInput = {
  token: string;
};

export type AdminStatsOutput = {
  sessions: number | bigint;
  uptimeMs: number | bigint;
  /** 활성 세션 사용자명 목록 — admin 가시성 예시. */
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
  /** 발급된 세션이 가진 초기 role — "admin" 이면 adminStats 요청 가능. */
  role: string;
};

export type SignOutInput = {
  token: string;
};

export type SignOutOutput = {
  signedOut: boolean;
};
