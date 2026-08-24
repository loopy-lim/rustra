export type BenchmarkResult = {
  name: string;
  correctness: true;
  warmup: number;
  iterations: number;
  repeats: number;
  normalization: 'trimmed-mean-5pct';
  averageNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  throughputOpsPerSecond: number;
};

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export async function benchmarkCommand<T>(options: {
  name: string;
  invoke: () => Promise<T>;
  validate: (result: T) => boolean;
  warmup: number;
  iterations: number;
  repeats?: number;
}): Promise<BenchmarkResult> {
  const first = await options.invoke();
  if (!options.validate(first)) {
    throw new Error(`${options.name}: correctness check failed before timing`);
  }

  for (let index = 0; index < options.warmup; index += 1) {
    await options.invoke();
  }

  const repeats = options.repeats ?? 3;
  const durations: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (let index = 0; index < options.iterations; index += 1) {
      const started = performance.now();
      await options.invoke();
      durations.push((performance.now() - started) * 1_000_000);
    }
  }

  const last = await options.invoke();
  if (!options.validate(last)) {
    throw new Error(`${options.name}: correctness check failed after timing`);
  }

  durations.sort((left, right) => left - right);
  const trim = Math.floor(durations.length * 0.05);
  const normalized = durations.slice(trim, durations.length - trim);
  const averageNs = normalized.reduce((sum, duration) => sum + duration, 0) / normalized.length;
  return {
    name: options.name,
    correctness: true,
    warmup: options.warmup,
    iterations: options.iterations,
    repeats,
    normalization: 'trimmed-mean-5pct',
    averageNs,
    p50Ns: percentile(durations, 0.5),
    p95Ns: percentile(durations, 0.95),
    p99Ns: percentile(durations, 0.99),
    throughputOpsPerSecond: 1_000_000_000 / averageNs,
  };
}
