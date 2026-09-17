import { describe, expect, test } from 'bun:test';
import { diagnosticOrder, parseDiagnosticURL, sampleDiagnostic } from './diagnostic';
import { verifyDiagnosticPreflight } from './diagnostic-verify';

describe('separate diagnostic schedules', () => {
  test('fixed schedules retain every measured round and invert the first framework', () => {
    expect(diagnosticOrder('rustra-only', 0)).toEqual(['rustra']);
    expect(diagnosticOrder('nitro-only', 1)).toEqual(['nitro']);
    expect(diagnosticOrder('alternating-rustra-first', 0)).toEqual(['rustra', 'nitro']);
    expect(diagnosticOrder('alternating-nitro-first', 0)).toEqual(['nitro', 'rustra']);
    expect(diagnosticOrder('alternating-rustra-first', 1)).toEqual(['nitro', 'rustra']);
  });
  test('rejects missing or unrecognized plans instead of choosing a favorable default', () => {
    expect(
      parseDiagnosticURL('rustra://diagnostic?case=buffer65536&schedule=nitro-only&run=a'),
    ).toEqual({ caseId: 'buffer65536', schedule: 'nitro-only', runId: 'a' });
    for (const url of [
      null,
      'https://example.com',
      'rustra://diagnostic?case=buffer65536&schedule=invalid&run=a',
      'rustra://diagnostic?case=buffer1&schedule=nitro-only&run=a',
    ])
      expect(() => parseDiagnosticURL(url)).toThrow();
  });
  test('single framework never invokes the competitor and consumes every result', () => {
    let n = 0,
      tick = 0;
    const samples = sampleDiagnostic(
      {
        rustra: () => {
          throw Error('wrong framework');
        },
        nitro: () => {
          n++;
          return { data: new ArrayBuffer(64) };
        },
      },
      'nitro-only',
      2,
      () => ++tick,
    );
    expect(n).toBe(34 * 2);
    expect(samples).toHaveLength(31);
    expect(
      samples.every(
        (s) =>
          s.framework === 'nitro' &&
          s.order === 0 &&
          s.nsPerOperation === 500000 &&
          s.checksum === 128,
      ),
    ).toBe(true);
  });
  test('paired schedules preserve raw order and reject asynchronous work', () => {
    let tick = 0;
    const samples = sampleDiagnostic(
      { rustra: () => 1, nitro: () => 2 },
      'alternating-nitro-first',
      1,
      () => ++tick,
    );
    expect(samples.slice(0, 2).map((x) => x.framework)).toEqual(['nitro', 'rustra']);
    expect(samples).toHaveLength(62);
    expect(() =>
      sampleDiagnostic({ rustra: () => Promise.resolve(1), nitro: () => 1 }, 'rustra-only', 1),
    ).toThrow('synchronous');
  });
});

test('diagnostic validation rejects stale identities, changed protocols and missing rounds', async () => {
  const { validateDiagnostic, DIAGNOSTIC_CONTRACT } = await import('./diagnostic');
  const expected = {
    caseId: 'buffer65536' as const,
    schedule: 'nitro-only' as const,
    runId: 'run1',
    fingerprint: 'a'.repeat(64),
    after: 1000,
  };
  const receipt = {
    ...expected,
    contract: DIAGNOSTIC_CONTRACT,
    platform: 'android',
    runtime: 'Hermes',
    release: true,
    startedAt: new Date(2000).toISOString(),
    finishedAt: new Date(3000).toISOString(),
    protocol: {
      rounds: 31,
      warmup: 3,
      batch: 8,
      preflight: 'selected-frameworks-only-two-fresh-values',
      memoryPressure: 'unchanged-native4',
      forcedGC: false,
    },
    samples: Array.from({ length: 31 }, (_, round) => ({
      round,
      order: 0,
      framework: 'nitro',
      nsPerOperation: 200,
      checksum: 524288,
    })),
  };
  expect(validateDiagnostic(receipt, expected).samples.length).toBe(31);
  for (const changed of [
    { ...receipt, contract: 'rustra-nitro-parity/v2' },
    { ...receipt, fingerprint: 'b'.repeat(64) },
    { ...receipt, startedAt: new Date(0).toISOString() },
    { ...receipt, protocol: { ...receipt.protocol, forcedGC: true } },
    { ...receipt, samples: receipt.samples.slice(1) },
    { ...receipt, samples: receipt.samples.map((s, i) => (i ? s : { ...s, framework: 'rustra' })) },
  ])
    expect(() => validateDiagnostic(changed, expected)).toThrow();
});

test('diagnostic admission requires the exact result for every fixed case and batch', async () => {
  const { validateDiagnostic, DIAGNOSTIC_CONTRACT } = await import('./diagnostic');
  const cases = [
    ['buffer65536', 8, 524288],
    ['buffer1048571', 1, 1048571],
    ['add', 256, 25600],
    ['string', 256, 4864],
    ['pair', 256, 31616],
  ] as const;
  for (const [caseId, batch, checksum] of cases) {
    const expected = {
      caseId,
      schedule: 'nitro-only' as const,
      runId: 'run1',
      fingerprint: 'a'.repeat(64),
      after: 1000,
    };
    const receipt = {
      contract: DIAGNOSTIC_CONTRACT,
      caseId,
      schedule: expected.schedule,
      runId: expected.runId,
      fingerprint: expected.fingerprint,
      platform: 'android',
      runtime: 'Hermes',
      release: true,
      startedAt: new Date(2000).toISOString(),
      finishedAt: new Date(3000).toISOString(),
      protocol: {
        rounds: 31,
        warmup: 3,
        batch,
        preflight: 'selected-frameworks-only-two-fresh-values',
        memoryPressure: 'unchanged-native4',
        forcedGC: false,
      },
      samples: Array.from({ length: 31 }, (_, round) => ({
        round,
        order: 0,
        framework: 'nitro',
        nsPerOperation: 200,
        checksum,
      })),
    };
    expect(validateDiagnostic(receipt, expected).samples).toHaveLength(31);
    for (const badChecksum of [1, checksum + 1, NaN]) {
      const samples = receipt.samples.map((sample, index) =>
        index === 10 ? { ...sample, checksum: badChecksum } : sample,
      );
      expect(() => validateDiagnostic({ ...receipt, samples }, expected)).toThrow();
    }
    const wrongOrder = receipt.samples.map((sample, index) =>
      index === 10 ? { ...sample, order: 1 } : sample,
    );
    expect(() => validateDiagnostic({ ...receipt, samples: wrongOrder }, expected)).toThrow();
    expect(() =>
      validateDiagnostic({ ...receipt, samples: receipt.samples.slice(1) }, expected),
    ).toThrow();
  }
});

test('preflight accepts two fresh equivalent buffers and primitive outputs', () => {
  const data = new Uint8Array(65536);
  for (let i = 0; i < data.length; i++) data[i] = (i * 17) % 251;
  const input = { data: data.buffer };
  const copy = () => ({ data: data.slice().buffer });
  expect(() => verifyDiagnosticPreflight('buffer65536', input, copy(), copy())).not.toThrow();
  expect(() =>
    verifyDiagnosticPreflight('add', { a: 42, b: 58 }, { value: 100 }, { value: 100 }),
  ).not.toThrow();
  expect(() =>
    verifyDiagnosticPreflight(
      'string',
      { value: 'Rustra ↔ Nitro: 문자열' },
      { value: 'Rustra ↔ Nitro: 문자열' },
      { value: 'Rustra ↔ Nitro: 문자열' },
    ),
  ).not.toThrow();
  expect(() =>
    verifyDiagnosticPreflight(
      'pair',
      { name: 'pair', value: 123.5 },
      { name: 'pair', value: 123.5 },
      { name: 'pair', value: 123.5 },
    ),
  ).not.toThrow();
});

test('preflight rejects output identity and backing-store aliases', () => {
  const data = new Uint8Array(65536);
  const input = { data: data.buffer };
  const fresh = () => ({ data: data.slice().buffer });
  const shared = data.slice().buffer;
  for (const [first, second] of [
    [input, fresh()],
    [fresh(), input],
    [{ data: input.data }, fresh()],
    [{ data: shared }, { data: new Uint8Array(shared) }],
  ] as const) {
    expect(() => verifyDiagnosticPreflight('buffer65536', input, first, second)).toThrow();
  }
  const repeated = fresh();
  expect(() => verifyDiagnosticPreflight('buffer65536', input, repeated, repeated)).toThrow();
  const pair = { name: 'pair', value: 123.5 };
  expect(() => verifyDiagnosticPreflight('pair', pair, pair, { ...pair })).toThrow();
});

test('preflight rejects wrong buffer bytes and lengths and wrong primitive fields', () => {
  const data = new Uint8Array(65536);
  const input = { data: data.buffer };
  const copy = () => ({ data: data.slice().buffer });
  expect(() =>
    verifyDiagnosticPreflight('buffer65536', input, { data: new ArrayBuffer(65535) }, copy()),
  ).toThrow();
  const wrong = data.slice();
  wrong[1] = 1;
  expect(() =>
    verifyDiagnosticPreflight('buffer65536', input, { data: wrong.buffer }, copy()),
  ).toThrow();
  expect(() =>
    verifyDiagnosticPreflight('add', { a: 42, b: 58 }, { value: 101 }, { value: 100 }),
  ).toThrow();
  expect(() =>
    verifyDiagnosticPreflight(
      'string',
      { value: 'Rustra ↔ Nitro: 문자열' },
      { value: 'bad' },
      { value: 'Rustra ↔ Nitro: 문자열' },
    ),
  ).toThrow();
  expect(() =>
    verifyDiagnosticPreflight(
      'pair',
      { name: 'pair', value: 123.5 },
      { name: 'wrong', value: 123.5 },
      { name: 'pair', value: 123.5 },
    ),
  ).toThrow();
  expect(() =>
    verifyDiagnosticPreflight(
      'pair',
      { name: 'pair', value: 123.5 },
      { name: 'pair', value: 124 },
      { name: 'pair', value: 123.5 },
    ),
  ).toThrow();
});
