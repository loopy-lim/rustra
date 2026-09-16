export type Samples = { rustra: number[]; nitro: number[]; checksum: number; batch: number };
type Options = { batch: number; rounds: number; warmup: number; clock?: () => number };
export function consume(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.nodes)) return v.nodes.length;
    if (typeof v.visited === 'number') return v.visited + Number(v.id);
    if ('data' in v) return consume(v.data);
    if ('value' in v) return consume(v.value);
    if ('nodes' in v) return Number(v.nodes);
  }
  throw new Error('unconsumed benchmark output');
}
function thenable(value: unknown): boolean {
  return value != null && typeof (value as { then?: unknown }).then === 'function';
}
function validate(options: Options) {
  if (
    ![options.batch, options.rounds].every((n) => Number.isInteger(n) && n > 0) ||
    options.warmup < 0
  )
    throw new Error('invalid sampling plan');
}
/** Entire measured path is synchronous: never introduce await/Promise wrapping here. */
export function measureSyncPair(
  rustra: () => unknown,
  nitro: () => unknown,
  options: Options,
): Samples {
  validate(options);
  const clock = options.clock ?? (() => performance.now());
  const result: Samples = { rustra: [], nitro: [], checksum: 0, batch: options.batch };
  for (let round = -options.warmup; round < options.rounds; round++) {
    for (const key of (Math.abs(round) % 2 ? ['nitro', 'rustra'] : ['rustra', 'nitro']) as (
      'rustra' | 'nitro'
    )[]) {
      const call = key === 'rustra' ? rustra : nitro;
      const start = clock();
      for (let i = 0; i < options.batch; i++) {
        const value = call();
        if (thenable(value)) throw new Error('sync lane returned Promise');
        result.checksum += consume(value);
      }
      const ns = ((clock() - start) * 1e6) / options.batch;
      if (round >= 0) result[key].push(ns);
    }
  }
  return result;
}
export async function measureAsyncPair(
  rustra: () => unknown,
  nitro: () => unknown,
  options: Options,
): Promise<Samples> {
  validate(options);
  const clock = options.clock ?? (() => performance.now());
  const result: Samples = { rustra: [], nitro: [], checksum: 0, batch: options.batch };
  for (let round = -options.warmup; round < options.rounds; round++) {
    for (const key of (Math.abs(round) % 2 ? ['nitro', 'rustra'] : ['rustra', 'nitro']) as (
      'rustra' | 'nitro'
    )[]) {
      const call = key === 'rustra' ? rustra : nitro;
      const start = clock();
      for (let i = 0; i < options.batch; i++) {
        const promise = call();
        if (!thenable(promise)) throw new Error('async lane did not return Promise');
        result.checksum += consume(await promise);
      }
      if (round >= 0) result[key].push(((clock() - start) * 1e6) / options.batch);
    }
  }
  return result;
}
export function summary(samples: number[]) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('invalid timing samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}
export type Confidence = { estimate: number; lower: number; upper: number };
/** One paired mean ratio per independent process, not per in-process timing sample. */
export function confidence(ratios: number[]): Confidence {
  if (ratios.length < 5) throw new Error('at least five independent launches required');
  if (ratios.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('invalid ratios');
  const logs = ratios.map(Math.log),
    n = logs.length,
    mean = logs.reduce((a, b) => a + b, 0) / n;
  // Two-sided 95% Student-t critical values indexed by df=n-1. Keep the
  // preregistered five-launch coefficient (2.776) unchanged for archived runs.
  // Beyond df=30, choose the next lower tabulated df, which widens the CI.
  const critical: [number, number][] = [
    [4, 2.776],
    [5, 2.570581835636315],
    [6, 2.446911848791681],
    [7, 2.364624251592784],
    [8, 2.306004135204166],
    [9, 2.262157162854099],
    [10, 2.228138851964939],
    [11, 2.200985160082949],
    [12, 2.178812829663418],
    [13, 2.160368656461012],
    [14, 2.144786687916927],
    [15, 2.131449545559323],
    [16, 2.119905299221011],
    [17, 2.109815577833181],
    [18, 2.10092204024096],
    [19, 2.093024054408263],
    [20, 2.085963447265837],
    [21, 2.079613844727662],
    [22, 2.073873067904014],
    [23, 2.068657610419041],
    [24, 2.063898561628021],
    [25, 2.059538552753294],
    [26, 2.055529438642871],
    [27, 2.051830516480283],
    [28, 2.048407141795244],
    [29, 2.045229642132703],
    [30, 2.042272456301237],
    [40, 2.021075390306274],
    [60, 2.00029782201426],
    [120, 1.979930405052777],
  ];
  let t = critical[0][1];
  for (const [df, value] of critical) {
    if (df > n - 1) break;
    t = value;
  }
  const se = Math.sqrt(logs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) / n);
  return {
    estimate: Math.exp(mean),
    lower: Math.exp(mean - t * se),
    upper: Math.exp(mean + t * se),
  };
}
export function classify(ci: Confidence) {
  if (ci.lower >= 0.95 && ci.upper <= 1.05) return 'equivalent';
  if (ci.upper < 1) return 'superior';
  if (ci.upper <= 1.05) return 'at-least-equivalent';
  if (ci.lower > 1.05) return 'slower';
  return 'inconclusive';
}
