// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { JobStatusInput, JobStatusOutput, StartJobInput, StartJobOutput } from './types.js';
import { invokeGenerated, invokeGeneratedFields1, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export function jobStatus(input: JobStatusInput, options?: InvokeOptions): Promise<JobStatusOutput> {
  return invokeGeneratedFields1<JobStatusOutput>(2, 'jobStatus', input, input["jobId"], options);
}
jobStatus.commandId = 'jobStatus';

export function startJob(input: StartJobInput, options?: InvokeOptions): Promise<StartJobOutput> {
  return invokeGeneratedFields3<StartJobOutput>(1, 'startJob', input, input["jobId"], input["totalSteps"], input["stepDelayMs"], options);
}
startJob.commandId = 'startJob';
