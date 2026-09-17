import { expect, test } from 'bun:test';
import { validateReceipt, aggregate } from './receipt';
import { CONTRACT } from './contract';
import { createExperimentManifest } from '../../scripts/parity-manifest';

const manifest = createExperimentManifest('a'.repeat(64));
function receipt(index = 0) {
  return {
    contract: CONTRACT,
    runId: `run-${index}`,
    startedAt: '2026-09-16T00:00:00Z',
    finishedAt: '2026-09-16T00:01:00Z',
    status: 'complete',
    runtime: 'Hermes',
    release: true,
    platform: 'ios',
    environment: 'simulator',
    fingerprint: manifest.fingerprint,
    generatedContract: manifest.generatedContract,
    nitroVersion: '0.37.1',
    nitrogenVersion: '0.37.1',
    rustraVersion: '0.10.2',
    representation: 'flat-arena',
    setupLifecycle: 'warm-full-build-and-replacement',
    baseline: manifest.baseline,
    cases: manifest.cases.map(({ rounds, ...c }) => ({
      ...c,
      verified: true,
      rustra: Array(rounds).fill(100),
      nitro: Array(rounds).fill(100),
      checksum: 2,
    })),
  };
}

test('receipt rejects stale version/fingerprint, missing, duplicate, unsupported and mismatched samples', () => {
  const r = receipt();
  validateReceipt(r, manifest);
  for (const bad of [
    { ...r, nitroVersion: '0.35.10' },
    { ...r, fingerprint: 'c'.repeat(64) },
    { ...r, status: 'failed' },
    { ...r, cases: r.cases.slice(1) },
    { ...r, cases: [...r.cases, r.cases[0]] },
    { ...r, cases: r.cases.map((c, i) => (i ? c : { ...c, verified: false })) },
    { ...r, cases: r.cases.map((c, i) => (i ? c : { ...c, nitro: [1] })) },
  ])
    expect(() => validateReceipt(bad, manifest)).toThrow();
});
test('aggregation needs five unique independent launches and same complete matrix/environment', () => {
  const rs = Array.from({ length: 5 }, (_, i) => receipt(i));
  expect(aggregate(rs, manifest)[0].classification).toBe('equivalent');
  expect(() => aggregate(rs.slice(1), manifest)).toThrow();
  expect(() => aggregate([rs[0], ...rs.slice(0, 4)], manifest)).toThrow();
  expect(() =>
    aggregate(
      rs.map((r, i) => (i ? r : { ...r, platform: 'android' })),
      manifest,
    ),
  ).toThrow();
});

test.each([
  ['generated contract', { generatedContract: 'c'.repeat(64) }],
  ['baseline', { baseline: 'f'.repeat(40) }],
  ['absent baseline', { baseline: undefined }],
] as const)(
  'same fingerprint with wrong %s is rejected against frozen manifest',
  (_label, patch) => {
    expect(() => validateReceipt({ ...receipt(), ...patch }, manifest)).toThrow();
    expect(() =>
      aggregate(
        Array.from({ length: 5 }, (_, i) => ({ ...receipt(i), ...patch })),
        manifest,
      ),
    ).toThrow();
  },
);
test.each([
  ['node count', { nodes: 255 }],
  ['byte size', { inputBytes: 1 }],
  ['byte meaning', { byteMeaning: 'payload only' }],
  ['batch', { batch: 99 }],
  ['rounds', { rustra: Array(32).fill(100), nitro: Array(32).fill(100) }],
] as const)('rejects five consistent wrong %s values under a valid case ID', (_label, patch) => {
  const bad = (index: number) => {
    const r = receipt(index);
    return {
      ...r,
      cases: r.cases.map((c) => (c.id === 'balanced8191/echo' ? { ...c, ...patch } : c)),
    };
  };
  expect(() => validateReceipt(bad(0), manifest)).toThrow();
  expect(() =>
    aggregate(
      Array.from({ length: 5 }, (_, i) => bad(i)),
      manifest,
    ),
  ).toThrow();
});

test('candidate v2 public-sync matrix and historical v1 matrices remain distinct and verifiable', () => {
  const base = receipt();
  const legacyCases = base.cases.filter((c) => c.lane !== 'sync-public');
  const legacyPlans = manifest.cases.filter((c) => c.lane !== 'sync-public');
  const legacy = { ...base, contract: 'rustra-nitro-parity/v1', cases: legacyCases };
  const legacyManifest = { ...manifest, contract: 'rustra-nitro-parity/v1', cases: legacyPlans };
  validateReceipt(legacy, legacyManifest);
  expect(legacy.cases).toHaveLength(60);
  const sync = legacyCases
    .filter((c) => c.lane === 'sync-internal-diagnostic')
    .map((c) => ({ ...c, lane: 'sync-public' as const }));
  const syncPlans = legacyPlans
    .filter((c) => c.lane === 'sync-internal-diagnostic')
    .map((c) => ({ ...c, lane: 'sync-public' as const }));
  const candidate = {
    ...base,
    contract: 'rustra-nitro-parity/v2',
    cases: [...legacyCases, ...sync],
  };
  const candidateManifest = {
    ...manifest,
    contract: 'rustra-nitro-parity/v2',
    cases: [...legacyPlans, ...syncPlans],
  };
  validateReceipt(candidate, candidateManifest);
  expect(candidate.cases).toHaveLength(90);
  expect(() => validateReceipt(candidate, legacyManifest)).toThrow();
  expect(() => validateReceipt(legacy, candidateManifest)).toThrow();
});
