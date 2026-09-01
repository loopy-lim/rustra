// ── rustra generated ────────────────────────────────────────
// File:   types.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export type JobStatusInput = {
  jobId: string;
};

export type JobStatusOutput = {
  pendingEvents: number | bigint;
  droppedEvents: number | bigint;
};

export type StartJobInput = {
  jobId: string;
  totalSteps: number | bigint;
  /** 각 스텝 사이 대기 (ms) — 데모용. */
  stepDelayMs: number | bigint;
};

export type StartJobOutput = {
  accepted: boolean;
};
