import type { JobStatusInput, JobStatusOutput, StartJobInput, StartJobOutput } from './types.js';
import { invokeGenerated } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export function jobStatus(input: JobStatusInput, options?: InvokeOptions): Promise<JobStatusOutput> {
  return invokeGenerated<JobStatusOutput>(2, 'jobStatus', input, options);
}
jobStatus.commandId = 'jobStatus';

export function startJob(input: StartJobInput, options?: InvokeOptions): Promise<StartJobOutput> {
  return invokeGenerated<StartJobOutput>(1, 'startJob', input, options);
}
startJob.commandId = 'startJob';

