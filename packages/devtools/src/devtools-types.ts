import type { EngineClient } from '@rustra/types';

export interface CommandStat {
  count: number;
  errors: number;
  totalMs: number;
}

export interface DevtoolsReport {
  totalCalls: number;
  commandStats: Record<string, CommandStat & { avgMs: number }>;
  batchStats: {
    count: number;
    entries: number;
    errors: number;
    totalMs: number;
    avgMs: number;
  };
  slowest: Array<{ command: string; ms: number }>;
  logs: DevtoolsLog[];
}

export interface InstrumentedEngine extends EngineClient {
  report(): DevtoolsReport;
}

export type DevtoolsLog = {
  kind: 'invoke' | 'invokeById' | 'batch';
  command: string;
  durationMs: number;
  ok: boolean;
  payload?: unknown;
  result?: unknown;
  error?: { code?: string; message: string };
};

export type InstrumentedEngineOptions = {
  capturePayload?: boolean;
  maxLogEntries?: number;
  onLog?: (entry: DevtoolsLog) => void;
};
