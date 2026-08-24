import { describe, expect, test } from 'bun:test';
import {
  isFreshReceipt,
  parseArguments,
  validateBenchmarkReceipt,
} from './extract-benchmark-receipt.mjs';

function confidence(estimate = 1) {
  return {
    estimate,
    lower: estimate * 0.99,
    upper: estimate * 1.01,
    confidenceLevel: 0.95,
    method: 'paired-batch-log-ratio-t',
    batchCount: 100,
  };
}

function fixture() {
  return {
    schemaVersion: 5,
    buildFingerprint: 'a'.repeat(64),
    generatedAt: '2026-08-24T00:00:00.000Z',
    platform: 'ios',
    buildMode: 'release',
    correctness: { equivalentOutputs: true, checkedBeforeTiming: true },
    equivalent: Object.fromEntries(
      ['add', 'string', 'bytes64', 'pair'].map((operation) => [
        operation,
        { confidence95: confidence() },
      ]),
    ),
    byteSizes: {
      bytes64KiB: { confidence95: confidence(0.99) },
      bytes1MiBWire: { confidence95: confidence(1.01) },
    },
    rawLowerBound: {
      bottleneckAnalysis: { recommendation: 'inspect-native-path' },
    },
    ffi: { available: true },
  };
}

describe('RN benchmark receipt extraction', () => {
  test('parses safe defaults and explicit overrides', () => {
    expect(parseArguments([])).toEqual({
      bundleId: 'com.alt-shifted.react-native-calculator',
      device: 'booted',
      output: undefined,
      timeoutMs: 120_000,
      launch: true,
    });
    expect(
      parseArguments(['--device', 'device-id', '--timeout-ms', '5000', '--no-launch']),
    ).toMatchObject({ device: 'device-id', timeoutMs: 5_000, launch: false });
  });

  test('accepts only complete release receipts with correctness and confidence gates', () => {
    expect(validateBenchmarkReceipt(fixture())).toEqual(fixture());
    expect(() => validateBenchmarkReceipt({ ...fixture(), buildMode: 'debug' })).toThrow(
      'iOS Release',
    );
    expect(() => validateBenchmarkReceipt({ ...fixture(), buildFingerprint: 'stale' })).toThrow(
      'build fingerprint',
    );
    expect(() =>
      validateBenchmarkReceipt({
        ...fixture(),
        correctness: { equivalentOutputs: false, checkedBeforeTiming: true },
      }),
    ).toThrow('correctness gate');
  });

  test('rejects a stale receipt from a prior app launch', () => {
    const receipt = fixture();
    expect(isFreshReceipt(receipt, Date.parse(receipt.generatedAt) + 1_000)).toBe(true);
    expect(isFreshReceipt(receipt, Date.parse(receipt.generatedAt) + 5_000)).toBe(false);
  });
});
