export type BenchResult = {
  label: string;
  avg: number;
  stddev: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  ops: number;
  batchMeans: number[];
};

export type PairedRatioConfidence = {
  estimate: number;
  lower: number;
  upper: number;
  confidenceLevel: 0.95;
  method: 'paired-batch-log-ratio-t';
  batchCount: number;
};

export type RouteDiagnostic = {
  native: BenchResult;
  generated: BenchResult;
  generatedToNative: number;
  confidence95: PairedRatioConfidence;
};

export type RouteBottleneck = {
  generatedToNative: number;
  confidence95: PairedRatioConfidence;
  classification: 'generated-helper' | 'native-path' | 'inconclusive';
};

export type RouteBottleneckAnalysis = {
  threshold: number;
  recommendation: 'optimize-generated-helper' | 'inspect-native-path' | 'collect-more-samples';
  operations: Record<string, RouteBottleneck>;
};

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function batches(samples: number[], maximumBatches = 100): number[][] {
  const batchSize = Math.max(1, Math.ceil(samples.length / maximumBatches));
  const result: number[][] = [];
  for (let start = 0; start < samples.length; start += batchSize) {
    result.push(samples.slice(start, start + batchSize));
  }
  return result;
}

function criticalT95(sampleCount: number): number {
  if (sampleCount <= 1) return 0;
  if (sampleCount === 2) return 12.706;
  if (sampleCount === 3) return 4.303;
  if (sampleCount === 4) return 3.182;
  if (sampleCount === 5) return 2.776;
  if (sampleCount <= 7) return 2.447;
  if (sampleCount <= 10) return 2.262;
  if (sampleCount <= 15) return 2.145;
  if (sampleCount <= 20) return 2.093;
  if (sampleCount <= 30) return 2.045;
  if (sampleCount <= 60) return 2.0;
  return 1.984;
}

export function summarize(label: string, samples: number[]): BenchResult {
  if (samples.length === 0) throw new Error('benchmark samples must not be empty');
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('benchmark samples must be finite non-negative numbers');
  }

  const times = Array.from(samples);
  times.sort((a, b) => a - b);
  const avg = average(times);
  const variance = average(times.map((time) => (time - avg) ** 2));
  const at = (percentile: number) =>
    times[Math.min(Math.floor(times.length * percentile), times.length - 1)];
  const batchMeans = batches(samples).map(average);

  return {
    label,
    avg,
    stddev: Math.sqrt(variance),
    min: times[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: times[times.length - 1],
    ops: avg === 0 ? Number.POSITIVE_INFINITY : 1_000_000_000 / avg,
    batchMeans,
  };
}

/**
 * Builds a confidence interval from aligned, interleaved samples. Ratios are
 * calculated from batch means before the log transform so timer quantization
 * on sub-microsecond calls cannot create zero/infinite per-call ratios.
 */
export function pairedRatioConfidence95(
  numeratorSamples: number[],
  denominatorSamples: number[],
  maximumBatches = 100,
): PairedRatioConfidence {
  if (numeratorSamples.length === 0 || numeratorSamples.length !== denominatorSamples.length) {
    throw new Error('paired benchmark samples must have the same non-zero length');
  }
  if (!Number.isInteger(maximumBatches) || maximumBatches < 2) {
    throw new Error('maximumBatches must be an integer greater than one');
  }

  const numeratorBatches = batches(numeratorSamples, maximumBatches);
  const denominatorBatches = batches(denominatorSamples, maximumBatches);
  const logRatios: number[] = [];
  for (let index = 0; index < numeratorBatches.length; index += 1) {
    const numerator = average(numeratorBatches[index]);
    const denominator = average(denominatorBatches[index]);
    if (numerator > 0 && denominator > 0) logRatios.push(Math.log(numerator / denominator));
  }
  if (logRatios.length === 0) {
    throw new Error('paired benchmark batches must contain positive timings');
  }

  const estimate = average(numeratorSamples) / average(denominatorSamples);
  if (logRatios.length === 1) {
    return {
      estimate,
      lower: estimate,
      upper: estimate,
      confidenceLevel: 0.95,
      method: 'paired-batch-log-ratio-t',
      batchCount: 1,
    };
  }

  const logEstimate = Math.log(estimate);
  const logMean = average(logRatios);
  const sampleVariance =
    logRatios.reduce((sum, value) => sum + (value - logMean) ** 2, 0) / (logRatios.length - 1);
  const margin = criticalT95(logRatios.length) * Math.sqrt(sampleVariance / logRatios.length);

  return {
    estimate,
    lower: Math.exp(logEstimate - margin),
    upper: Math.exp(logEstimate + margin),
    confidenceLevel: 0.95,
    method: 'paired-batch-log-ratio-t',
    batchCount: logRatios.length,
  };
}

export function analyzeRouteBottlenecks(
  diagnostics: Record<string, RouteDiagnostic>,
  threshold = 1.05,
): RouteBottleneckAnalysis {
  if (!Number.isFinite(threshold) || threshold <= 1) {
    throw new Error('route bottleneck threshold must be greater than one');
  }

  const operations = Object.fromEntries(
    Object.entries(diagnostics).map(([operation, diagnostic]) => {
      const classification: RouteBottleneck['classification'] =
        diagnostic.confidence95.lower > threshold
          ? 'generated-helper'
          : diagnostic.confidence95.upper <= threshold
            ? 'native-path'
            : 'inconclusive';
      return [
        operation,
        {
          generatedToNative: diagnostic.generatedToNative,
          confidence95: diagnostic.confidence95,
          classification,
        },
      ];
    }),
  );
  const classifications = Object.values(operations).map((entry) => entry.classification);
  const recommendation = classifications.includes('generated-helper')
    ? 'optimize-generated-helper'
    : classifications.includes('inconclusive')
      ? 'collect-more-samples'
      : 'inspect-native-path';

  return { threshold, recommendation, operations };
}
