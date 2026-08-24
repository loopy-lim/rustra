import { addNumbers } from '../../calculator/generated/tauri.js';

type BenchmarkResult = {
  name: string;
  correctness: true;
  warmup: number;
  iterations: number;
  repeats: number;
  batchSize: number;
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

async function measure(): Promise<BenchmarkResult> {
  const first = await addNumbers({ a: 20, b: 22 });
  if (first.value !== 42) throw new Error(`expected 42, got ${first.value}`);

  const warmup = 100;
  // WKWebView's timer is quantized to roughly 1 ms in this context. Measure
  // batches and divide by the batch size so p50/p95 are not reported as 0 ms.
  const batchSize = 20;
  const batches = 50;
  const iterations = batchSize * batches;
  const repeats = 3;
  for (let index = 0; index < warmup; index += 1) {
    await addNumbers({ a: 20, b: 22 });
  }

  const durations: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (let batch = 0; batch < batches; batch += 1) {
      const started = performance.now();
      for (let index = 0; index < batchSize; index += 1) {
        await addNumbers({ a: 20, b: 22 });
      }
      durations.push(((performance.now() - started) * 1_000_000) / batchSize);
    }
  }

  const last = await addNumbers({ a: 20, b: 22 });
  if (last.value !== 42) throw new Error(`expected 42, got ${last.value}`);

  durations.sort((left, right) => left - right);
  const trim = Math.floor(durations.length * 0.05);
  const normalized = durations.slice(trim, durations.length - trim);
  const averageNs = normalized.reduce((sum, duration) => sum + duration, 0) / normalized.length;
  return {
    name: 'tauri-generated-webview-ipc',
    correctness: true,
    warmup,
    iterations,
    repeats,
    batchSize,
    normalization: 'trimmed-mean-5pct',
    averageNs,
    p50Ns: percentile(durations, 0.5),
    p95Ns: percentile(durations, 0.95),
    p99Ns: percentile(durations, 0.99),
    throughputOpsPerSecond: 1_000_000_000 / averageNs,
  };
}

try {
  const result = await measure();
  const response = await fetch('http://127.0.0.1:19473/rustra-benchmark', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rustra-benchmark': 'receipt-v1',
    },
    body: JSON.stringify({ runtime: navigator.userAgent, results: [result] }),
  });
  if (!response.ok) throw new Error(`receipt server returned ${response.status}`);
} catch (error: unknown) {
  document.body.dataset.benchmarkError = error instanceof Error ? error.message : String(error);
  throw error;
}
