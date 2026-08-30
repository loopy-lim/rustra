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

/** E1 성분 분해 — `rustra_dispatch_profiled` 응답 (Rust Instant 차분 포함). */
type ProfiledResponse = {
  result: { value: number };
  ok: boolean;
  native_ns: number;
};

type TauriCore = { invoke?: (command: string, args?: unknown) => Promise<unknown> };

function requireTauriInvoke(): (command: string, args?: unknown) => Promise<unknown> {
  const core = (globalThis as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
  if (typeof core?.invoke !== 'function') {
    throw new Error('Tauri IPC not found (app.withGlobalTauri disabled?)');
  }
  return core.invoke.bind(core);
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function summarize(
  durations: number[],
  extra: Pick<BenchmarkResult, 'name' | 'warmup' | 'iterations' | 'repeats' | 'batchSize'>,
): BenchmarkResult {
  durations.sort((left, right) => left - right);
  const trim = Math.floor(durations.length * 0.05);
  const normalized = durations.slice(trim, durations.length - trim);
  const averageNs = normalized.reduce((sum, duration) => sum + duration, 0) / normalized.length;
  return {
    ...extra,
    correctness: true,
    normalization: 'trimmed-mean-5pct',
    averageNs,
    p50Ns: percentile(durations, 0.5),
    p95Ns: percentile(durations, 0.95),
    p99Ns: percentile(durations, 0.99),
    throughputOpsPerSecond: 1_000_000_000 / averageNs,
  };
}

async function measure(): Promise<{
  production: BenchmarkResult;
  profiled: BenchmarkResult & { nativeNsAvg: number; crossingResidualNs: number };
}> {
  const first = await addNumbers({ a: 20, b: 22 });
  if (first.value !== 42) throw new Error(`expected 42, got ${first.value}`);

  const tauriInvoke = requireTauriInvoke();
  const warmup = 100;
  // WKWebView 타이머는 ~1ms 그리드 — batch 를 1000 으로 올려 1µs/call 해상도를
  // 확보한다 (트랙 E1: 20×50 = 50µs 그리드 왜곡 제거).
  const batchSize = 1000;
  const batches = 10;
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

  // 성분 분해: profiled 명령으로 RTT 와 네이티브 처리 시간을 함께 수집한다.
  // 크로싱 잔차 = RTT − 네이티브 (JS 직렬화 + WebKit 왕복 잔여).
  const profiledSamples: number[] = [];
  const nativeSamples: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const response = (await tauriInvoke('rustra_dispatch_profiled', {
      command: 'addNumbers',
      args: { a: 20, b: 22 },
    })) as ProfiledResponse;
    profiledSamples.push((performance.now() - started) * 1_000_000);
    if (!response.ok || response.result.value !== 42) {
      throw new Error('profiled dispatch returned unexpected result');
    }
    nativeSamples.push(Number(response.native_ns));
  }
  const profiledSummary = summarize(profiledSamples, {
    name: 'tauri-profiled-dispatch',
    warmup: 0,
    iterations: profiledSamples.length,
    repeats: 1,
    batchSize: 1,
  });
  const nativeNsAvg = nativeSamples.reduce((sum, v) => sum + v, 0) / nativeSamples.length;

  return {
    production: summarize(durations, {
      name: 'tauri-generated-webview-ipc',
      warmup,
      iterations,
      repeats,
      batchSize,
    }),
    profiled: {
      ...profiledSummary,
      nativeNsAvg,
      crossingResidualNs: profiledSummary.averageNs - nativeNsAvg,
    },
  };
}

try {
  const { production, profiled } = await measure();
  const response = await fetch('http://127.0.0.1:19473/rustra-benchmark', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rustra-benchmark': 'receipt-v1',
    },
    body: JSON.stringify({
      runtime: navigator.userAgent,
      results: [production],
      decomposition: {
        rttAvgNs: profiled.averageNs,
        nativeNsAvg: profiled.nativeNsAvg,
        crossingResidualNs: profiled.crossingResidualNs,
        samples: profiled.iterations,
      },
    }),
  });
  if (!response.ok) throw new Error(`receipt server returned ${response.status}`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.dataset.benchmarkError = message;
  // 진단 전송 — WebView 콘솔이 보이지 않는 환경에서 실패 원인을 수신자에 남긴다.
  try {
    await fetch('http://127.0.0.1:19473/rustra-benchmark', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rustra-benchmark': 'receipt-v1' },
      body: JSON.stringify({ error: message, ua: navigator.userAgent }),
    });
  } catch {
    // 수신자 없음 — 원래 에러를 그대로 노출한다.
  }
  throw error;
}
