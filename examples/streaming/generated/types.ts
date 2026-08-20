export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export type JobStatusInput = {
  jobId: string;
};

export type JobStatusOutput = {
  pendingEvents: number;
  droppedEvents: number;
};

export type StartJobInput = {
  jobId: string;
  totalSteps: number;
  /** 각 스텝 사이 대기 (ms) — 데모용. */
  stepDelayMs: number;
};

export type StartJobOutput = {
  accepted: boolean;
};

