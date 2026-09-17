/** Diagnostic protocol only: it never changes the v2 parity matrix or its gate. */
import { consume } from './measurement';
export const DIAGNOSTIC_CONTRACT = 'rustra-nitro-diagnostic/v1';
export const SCHEDULES = [
  'rustra-only',
  'nitro-only',
  'alternating-rustra-first',
  'alternating-nitro-first',
] as const;
export type Schedule = (typeof SCHEDULES)[number];
export type Framework = 'rustra' | 'nitro';
export const DIAGNOSTIC_CASES = ['buffer65536', 'buffer1048571', 'add', 'string', 'pair'] as const;
export type DiagnosticCase = (typeof DIAGNOSTIC_CASES)[number];
export function parseDiagnosticURL(url: string | null): {
  caseId: DiagnosticCase;
  schedule: Schedule;
  runId: string;
} {
  if (!url) throw Error('diagnostic launch URL required');
  // Fixed host-generated grammar avoids platform differences in URL polyfills.
  const match =
    /^rustra:\/\/diagnostic\?case=([a-z0-9]+)&schedule=([a-z-]+)&run=([a-zA-Z0-9_-]{1,100})$/.exec(
      url,
    );
  if (!match) throw Error('invalid diagnostic URL grammar');
  const [, caseId, schedule, runId] = match;
  if (
    !DIAGNOSTIC_CASES.includes(caseId as DiagnosticCase) ||
    !SCHEDULES.includes(schedule as Schedule)
  )
    throw Error('invalid diagnostic case or schedule');
  return { caseId: caseId as DiagnosticCase, schedule: schedule as Schedule, runId };
}
export function diagnosticOrder(schedule: Schedule, round: number): Framework[] {
  if (schedule === 'rustra-only') return ['rustra'];
  if (schedule === 'nitro-only') return ['nitro'];
  const rustraFirst = (Math.abs(round) % 2 === 0) === (schedule === 'alternating-rustra-first');
  return rustraFirst ? ['rustra', 'nitro'] : ['nitro', 'rustra'];
}
export function sampleDiagnostic(
  calls: Record<Framework, () => unknown>,
  schedule: Schedule,
  batch: number,
  clock = () => performance.now(),
) {
  if (!Number.isInteger(batch) || batch < 1) throw Error('invalid batch');
  const samples = [];
  for (let round = -3; round < 31; round++) {
    for (const [order, framework] of diagnosticOrder(schedule, round).entries()) {
      let checksum = 0;
      const start = clock();
      for (let i = 0; i < batch; i++) {
        const result = calls[framework]();
        if (result != null && typeof (result as { then?: unknown }).then === 'function')
          throw Error('diagnostic call must be synchronous');
        checksum += consume(result);
      }
      const nsPerOperation = ((clock() - start) * 1e6) / batch;
      if (!Number.isFinite(nsPerOperation) || nsPerOperation <= 0)
        throw Error('invalid diagnostic timing');
      if (round >= 0) samples.push({ round, order, framework, nsPerOperation, checksum });
    }
  }
  return samples;
}

export type DiagnosticPlan = ReturnType<typeof parseDiagnosticURL>;
export function validateDiagnostic(
  value: unknown,
  expected: DiagnosticPlan & { fingerprint: string; after: number },
) {
  const r = value as {
    contract: string;
    caseId: string;
    schedule: Schedule;
    runId: string;
    fingerprint: string;
    platform: string;
    runtime: string;
    release: boolean;
    startedAt: string;
    finishedAt: string;
    protocol: {
      rounds: number;
      warmup: number;
      batch: number;
      preflight: string;
      memoryPressure: string;
      forcedGC: boolean;
    };
    samples: ReturnType<typeof sampleDiagnostic>;
  };
  const batch =
    expected.caseId === 'buffer65536' ? 8 : expected.caseId === 'buffer1048571' ? 1 : 256;
  const result =
    expected.caseId === 'buffer65536'
      ? 65536
      : expected.caseId === 'buffer1048571'
        ? 1048571
        : expected.caseId === 'add'
          ? 100
          : expected.caseId === 'string'
            ? 'Rustra ↔ Nitro: 문자열'.length
            : 123.5;
  const expectedChecksum = result * batch;
  if (
    !r ||
    r.contract !== DIAGNOSTIC_CONTRACT ||
    r.caseId !== expected.caseId ||
    r.schedule !== expected.schedule ||
    r.runId !== expected.runId ||
    r.fingerprint !== expected.fingerprint ||
    r.runtime !== 'Hermes' ||
    r.release !== true ||
    r.platform !== 'android' ||
    !Number.isFinite(Date.parse(r.startedAt)) ||
    Date.parse(r.startedAt) < expected.after ||
    !Number.isFinite(Date.parse(r.finishedAt)) ||
    Date.parse(r.finishedAt) < Date.parse(r.startedAt)
  )
    throw Error('diagnostic identity mismatch');
  if (
    !r.protocol ||
    r.protocol.rounds !== 31 ||
    r.protocol.warmup !== 3 ||
    r.protocol.batch !== batch ||
    r.protocol.preflight !== 'selected-frameworks-only-two-fresh-values' ||
    r.protocol.memoryPressure !== 'unchanged-native4' ||
    r.protocol.forcedGC !== false
  )
    throw Error('diagnostic protocol mismatch');
  const order = Array.from({ length: 31 }, (_, round) =>
    diagnosticOrder(expected.schedule, round).map((framework, order) => ({
      round,
      order,
      framework,
    })),
  ).flat();
  if (!Array.isArray(r.samples) || r.samples.length !== order.length)
    throw Error('incomplete diagnostic samples');
  for (const [i, sample] of r.samples.entries()) {
    if (
      sample.round !== order[i].round ||
      sample.order !== order[i].order ||
      sample.framework !== order[i].framework ||
      !Number.isFinite(sample.nsPerOperation) ||
      sample.nsPerOperation <= 0 ||
      sample.checksum !== expectedChecksum
    )
      throw Error('invalid diagnostic sample');
  }
  return r;
}
