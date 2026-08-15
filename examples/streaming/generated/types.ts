export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

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
  stepDelayMs: number;
};

export type StartJobOutput = {
  accepted: boolean;
};

