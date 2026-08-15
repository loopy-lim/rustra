import type { JobStatusInput, JobStatusOutput, StartJobInput, StartJobOutput } from './types.js';
import { invoke } from '@rustra/types';

export function jobStatus(input: JobStatusInput): Promise<JobStatusOutput> {
  return invoke<JobStatusOutput>('jobStatus', input);
}

export function startJob(input: StartJobInput): Promise<StartJobOutput> {
  return invoke<StartJobOutput>('startJob', input);
}

