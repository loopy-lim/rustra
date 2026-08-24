import { describe, expect, test } from 'bun:test';
import { analyzeRouteBottlenecks, pairedRatioConfidence95, summarize } from './benchmark-stats';

function diagnostic(ratio, lower, upper) {
  const native = summarize('native', [100, 100, 100, 100]);
  const generated = summarize('generated', [ratio * 100, ratio * 100, ratio * 100, ratio * 100]);
  return {
    native,
    generated,
    generatedToNative: ratio,
    confidence95: {
      estimate: ratio,
      lower,
      upper,
      confidenceLevel: 0.95,
      method: 'paired-batch-log-ratio-t',
      batchCount: 4,
    },
  };
}

describe('benchmark statistics', () => {
  test('summarizes samples without mutating their order', () => {
    const samples = [30, 10, 20];
    const result = summarize('fixture', samples);

    expect(samples).toEqual([30, 10, 20]);
    expect(result.avg).toBe(20);
    expect(result.p50).toBe(20);
    expect(result.min).toBe(10);
    expect(result.max).toBe(30);
  });

  test('computes a tight paired ratio interval for a fixed multiplicative cost', () => {
    const denominator = Array.from({ length: 200 }, (_, index) => 90 + (index % 11));
    const numerator = denominator.map((value) => value * 1.04);
    const confidence = pairedRatioConfidence95(numerator, denominator);

    expect(confidence.estimate).toBeCloseTo(1.04, 10);
    expect(confidence.lower).toBeCloseTo(1.04, 10);
    expect(confidence.upper).toBeCloseTo(1.04, 10);
    expect(confidence.batchCount).toBe(100);
  });

  test('rejects unpaired samples instead of emitting a misleading interval', () => {
    expect(() => pairedRatioConfidence95([1, 2], [1])).toThrow('same non-zero length');
  });

  test('classifies only confidence-bound overhead as a helper bottleneck', () => {
    const analysis = analyzeRouteBottlenecks({
      add: diagnostic(1.12, 1.08, 1.16),
      bytes: diagnostic(1.01, 0.98, 1.04),
      pair: diagnostic(1.05, 1.02, 1.08),
    });

    expect(analysis.operations.add.classification).toBe('generated-helper');
    expect(analysis.operations.bytes.classification).toBe('native-path');
    expect(analysis.operations.pair.classification).toBe('inconclusive');
    expect(analysis.recommendation).toBe('optimize-generated-helper');
  });
});
