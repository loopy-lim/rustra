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
  /**
   * (M8) 실패 프레임 포렌식 — 정규화된 tier2 디코드 에러(`invoke.malformed`,
   * `RustraCommandError.frameBytes`) 가 응답 프레임을 싣고 있으면 앞 256B 만
   * hex 로 남긴다. 성공 로그와 프레임이 없는 실패에는 undefined 다(additive —
   * 기존 로그 소비자·렌더러 무영향). 프로세스가 끝난 뒤에도 와이어를 재해석할
   * 수 있게 하는 것이 목적으로, hex 대신 원시 바이트를 남기지 않는다(로그 크기
   * 상한 보존).
   */
  frameBytesHex?: string;
  /** (M8) `frameBytesHex` 원본 프레임의 전체 길이 — 256B 절단 여부 판정에 쓴다. */
  frameByteLength?: number;
};

export type InstrumentedEngineOptions = {
  capturePayload?: boolean;
  maxLogEntries?: number;
  onLog?: (entry: DevtoolsLog) => void;
};
