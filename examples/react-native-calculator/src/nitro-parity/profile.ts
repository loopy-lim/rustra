import { consume } from './measurement';

export const PROFILE_CONTRACT = 'rustra-nitro-profile/v1';
export const PROFILE_CASES = [
  'add',
  'string',
  'pair',
  'balanced8191/indexed',
  'balanced8191/resident-dfs',
  'balanced8191/echo',
  'balanced8191/input-dfs',
  'buffer65536',
  'buffer1048571',
] as const;
export type ProfileCase = (typeof PROFILE_CASES)[number];
export type ProfileFramework = 'rustra' | 'nitro';
export type ProfilePlan = {
  caseId: ProfileCase;
  framework: ProfileFramework;
  runId: string;
  durationMs: number;
};

/** Small fixed grammar keeps launch admission independent of Hermes URL polyfills. */
export function parseProfileURL(url: string | null): ProfilePlan {
  const prefix = 'rustra-parity://profile?';
  if (!url?.startsWith(prefix)) throw Error('invalid profile URL');
  const values: Record<string, string> = {};
  for (const pair of url.slice(prefix.length).split('&')) {
    const index = pair.indexOf('=');
    if (index <= 0 || pair.indexOf('=', index + 1) !== -1) throw Error('invalid profile query');
    const key = pair.slice(0, index);
    if (!['case', 'framework', 'run', 'ms'].includes(key) || key in values)
      throw Error('duplicate or unknown profile query key');
    try {
      values[key] = decodeURIComponent(pair.slice(index + 1));
    } catch {
      throw Error('malformed profile query encoding');
    }
  }
  const { case: caseId, framework, run: runId, ms } = values;
  if (
    !PROFILE_CASES.includes(caseId as ProfileCase) ||
    (framework !== 'rustra' && framework !== 'nitro') ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(runId ?? '') ||
    !/^[0-9]+$/.test(ms ?? '')
  )
    throw Error('invalid profile plan');
  const durationMs = Number(ms);
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 15000)
    throw Error('invalid profile duration');
  return { caseId: caseId as ProfileCase, framework, runId, durationMs };
}

export function profileValue(value: unknown): number {
  if (value != null && typeof (value as { then?: unknown }).then === 'function')
    throw Error('profile call must be synchronous');
  const checksum = consume(value);
  if (!Number.isFinite(checksum) || checksum <= 0 || Math.abs(checksum) > Number.MAX_SAFE_INTEGER)
    throw Error('invalid profile checksum');
  return checksum;
}

/** Diagnostic duration includes calls and one deadline check per complete batch. */
export function runProfile(
  call: () => unknown,
  batch: number,
  durationMs: number,
  expectedPerCall: number,
  clock: () => number = () => performance.now(),
): { elapsedMs: number; iterations: number; checksum: number } {
  if (
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 256 ||
    !Number.isInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 15000 ||
    !Number.isFinite(expectedPerCall) ||
    expectedPerCall <= 0 ||
    Math.abs(expectedPerCall) > Number.MAX_SAFE_INTEGER
  )
    throw Error('invalid profile loop plan');
  const start = clock();
  if (!Number.isFinite(start)) throw Error('invalid profile clock');
  let end = start;
  let checksum = 0;
  let iterations = 0;
  do {
    for (let i = 0; i < batch; i++) {
      if (profileValue(call()) !== expectedPerCall) throw Error('profile checksum mismatch');
      checksum += expectedPerCall;
      iterations++;
      if (
        !Number.isFinite(checksum) ||
        Math.abs(checksum) > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(iterations)
      )
        throw Error('unsafe profile checksum or iterations');
    }
    const now = clock();
    if (!Number.isFinite(now) || now < end) throw Error('invalid profile clock');
    end = now;
  } while (end - start < durationMs);
  return { elapsedMs: end - start, iterations, checksum };
}
