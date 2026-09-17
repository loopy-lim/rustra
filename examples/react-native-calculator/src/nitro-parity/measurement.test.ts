import { expect, test } from 'bun:test';
import { measureSyncPair, measureAsyncPair, confidence, classify } from './measurement';
test('sync batches alternate competitors, consume results and reject Promises', () => {
  let time = 0;
  const order: string[] = [];
  const run = (key: string) => () => {
    order.push(key);
    time += key === 'r' ? 2 : 1;
    return 7;
  };
  const result = measureSyncPair(run('r'), run('n'), {
    batch: 3,
    rounds: 4,
    warmup: 0,
    clock: () => time,
  });
  expect(result.rustra).toEqual([2e6, 2e6, 2e6, 2e6]);
  expect(result.nitro).toEqual([1e6, 1e6, 1e6, 1e6]);
  expect(order.join('')).toBe('rrrnnnnnnrrrrrrnnnnnnrrr');
  expect(result.checksum).toBe(168);
  expect(() =>
    measureSyncPair(
      () => Promise.resolve(1),
      () => 1,
      { batch: 1, rounds: 2, warmup: 0 },
    ),
  ).toThrow('Promise');
});
test('async lane requires actual Promise on both sides', async () => {
  await expect(
    measureAsyncPair(
      () => 1,
      () => Promise.resolve(1),
      { batch: 1, rounds: 2, warmup: 0 },
    ),
  ).rejects.toThrow('Promise');
});
test('preregistered gate distinguishes equivalents, faster, slow and ambiguous distributions', () => {
  expect(classify(confidence([1, 1, 1, 1, 1]))).toBe('equivalent');
  expect(classify(confidence([0.7, 0.7, 0.7, 0.7, 0.7]))).toBe('superior');
  expect(classify(confidence([1.2, 1.2, 1.2, 1.2, 1.2]))).toBe('slower');
  expect(classify(confidence([0.5, 1.5, 0.8, 1.4, 0.7]))).toBe('inconclusive');
  expect(classify({ lower: 0.9, upper: 1.03, estimate: 1 })).toBe('at-least-equivalent');
  expect(() => confidence([1, 1, 1, 1])).toThrow('five');
  expect(() => confidence([1, 1, 1, 1, NaN])).toThrow();
});
test.each([
  [5, 2.776],
  [9, 2.306004135204166],
  [12, 2.200985160082949],
  [17, 2.119905299221011],
  [18, 2.109815577833181],
  [31, 2.042272456301237],
  [41, 2.021075390306274],
  [61, 2.00029782201426],
  [121, 1.979930405052777],
])('CI uses correct n-1 degrees of freedom for %d launches', (count, t) => {
  const ratios = Array.from({ length: count }, (_, i) => Math.exp(((i % 3) - 1) * 0.1));
  const logs = ratios.map(Math.log),
    mean = logs.reduce((a, b) => a + b, 0) / count;
  const se = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1) / count);
  const ci = confidence(ratios);
  expect(ci.lower).toBeCloseTo(Math.exp(mean - t * se), 12);
  expect(ci.upper).toBeCloseTo(Math.exp(mean + t * se), 12);
});
