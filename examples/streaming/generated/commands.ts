import type { JobStatusInput, JobStatusOutput, StartJobInput, StartJobOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export function jobStatus(input: JobStatusInput, options?: InvokeOptions): Promise<JobStatusOutput> {
  return invoke<JobStatusOutput>('jobStatus', input, options);
}

export function startJob(input: StartJobInput, options?: InvokeOptions): Promise<StartJobOutput> {
  return invoke<StartJobOutput>('startJob', input, options);
}

