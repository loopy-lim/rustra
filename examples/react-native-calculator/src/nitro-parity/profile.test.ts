import { describe, expect, test } from 'bun:test';
import { parseProfileURL, runProfile } from './profile';

describe('profile launch admission', () => {
  test('accepts only the fixed case set and exact launch identity', () => {
    for (const caseId of [
      'add',
      'string',
      'pair',
      'balanced8191/indexed',
      'balanced8191/resident-dfs',
      'balanced8191/echo',
      'balanced8191/input-dfs',
      'buffer65536',
      'buffer1048571',
    ] as const) {
      expect(
        parseProfileURL(
          `rustra-parity://profile?case=${encodeURIComponent(caseId)}&framework=rustra&run=Run_1-2&ms=12000`,
        ),
      ).toEqual({ caseId, framework: 'rustra', runId: 'Run_1-2', durationMs: 12000 });
    }
    expect(
      parseProfileURL('rustra-parity://profile?ms=1000&run=a&framework=nitro&case=add'),
    ).toEqual({ caseId: 'add', framework: 'nitro', runId: 'a', durationMs: 1000 });
  });

  test('rejects ambiguous, malformed, or unbounded launch plans', () => {
    const base = 'rustra-parity://profile?case=add&framework=nitro&run=a&ms=12000';
    for (const url of [
      null,
      '',
      base.replace('rustra-parity://profile', 'rustra-parity://other'),
      base.replace('rustra-parity://profile', 'https://profile'),
      base + '&case=pair',
      base + '&unknown=x',
      base.replace('&run=a', ''),
      base.replace('case=add', 'case=balanced8191%2'),
      base.replace('case=add', 'case=balanced8191%2Fsetup'),
      base.replace('framework=nitro', 'framework=other'),
      base.replace('run=a', 'run=bad%20token'),
      base.replace('run=a', `run=${'x'.repeat(81)}`),
      base.replace('ms=12000', 'ms=999'),
      base.replace('ms=12000', 'ms=15001'),
      base.replace('ms=12000', 'ms=1.5'),
      base.replace('ms=12000', 'ms=Infinity'),
      base + '#fragment',
    ])
      expect(() => parseProfileURL(url)).toThrow();
    expect(parseProfileURL(base.replace('ms=12000', 'ms=15000')).durationMs).toBe(15000);
  });
});

describe('bounded synchronous profile loop', () => {
  test('runs whole batches then checks the deadline, consuming every exact result', () => {
    let calls = 0;
    const times = [100, 600, 1100];
    const result = runProfile(
      () => {
        calls++;
        return { value: 100 };
      },
      3,
      1000,
      100,
      () => times.shift()!,
    );
    expect(calls).toBe(6);
    expect(result).toEqual({ elapsedMs: 1000, iterations: 6, checksum: 600 });
  });

  test('rejects async or incorrect outputs even inside a batch', () => {
    expect(() =>
      runProfile(
        () => Promise.resolve(100),
        1,
        1000,
        100,
        () => 0,
      ),
    ).toThrow('synchronous');
    expect(() =>
      runProfile(
        () => ({ value: 99 }),
        1,
        1000,
        100,
        () => 0,
      ),
    ).toThrow('checksum');
    expect(() =>
      runProfile(
        () => ({ value: Number.NaN }),
        1,
        1000,
        100,
        () => 0,
      ),
    ).toThrow();
    expect(() =>
      runProfile(
        () => ({}),
        1,
        1000,
        100,
        () => 0,
      ),
    ).toThrow();
  });

  test('rejects nonfinite, backwards, and invalid clock or sampling bounds', () => {
    for (const times of [[0, NaN], [10, 9], [Infinity]]) {
      expect(() =>
        runProfile(
          () => 1,
          1,
          1000,
          1,
          () => times.shift()!,
        ),
      ).toThrow('clock');
    }
    for (const batch of [0, 257, 1.5]) expect(() => runProfile(() => 1, batch, 1000, 1)).toThrow();
    expect(() => runProfile(() => 1, 1, 1000, 0)).toThrow();
  });
});
