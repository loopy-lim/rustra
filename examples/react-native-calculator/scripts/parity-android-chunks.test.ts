import { expect, test } from 'bun:test';
import { extractAndroidReceipt } from './parity-android-chunks';

const marker = 'RUSTRA_PARITY_CHUNK=';
const line = (index: number, text: string, total = 2, runId = 'run-a') =>
  marker + JSON.stringify({ index, text, total, runId });

test('reconstructs reordered chunks and accepts identical repeated log lines', () => {
  const first = line(0, '{"runId":"run-a",');
  const second = line(1, '"status":"complete"}');
  expect(extractAndroidReceipt(['unrelated progress', second, first, first].join('\n'))).toEqual({
    runId: 'run-a',
    status: 'complete',
  });
});

test('waits for missing chunks without accepting truncated JSON', () => {
  expect(extractAndroidReceipt(line(1, '"status":"complete"}'))).toBeUndefined();
  expect(extractAndroidReceipt('')).toBeUndefined();
});

test('rejects mixed runs, conflicting duplicates and inconsistent counts', () => {
  expect(() => extractAndroidReceipt(line(0, '{}') + '\n' + line(1, '{}', 2, 'run-b'))).toThrow();
  expect(() => extractAndroidReceipt(line(0, '{}') + '\n' + line(0, '[]'))).toThrow();
  expect(() => extractAndroidReceipt(line(0, '{}') + '\n' + line(1, '{}', 3))).toThrow();
});

test('rejects invalid indices, malformed envelopes and mismatched payload identities', () => {
  for (const bad of [
    line(-1, '{}'),
    line(2, '{}'),
    line(0, '{}', 0),
    marker + '{}',
    marker + 'invalid',
  ]) {
    expect(() => extractAndroidReceipt(bad)).toThrow();
  }
  expect(() => extractAndroidReceipt(line(0, '{"runId":"run-b"}', 1))).toThrow();
});

test('surfaces native preflight failures immediately', () => {
  expect(() => extractAndroidReceipt('RUSTRA_PARITY_FAILED=Error: wrong output')).toThrow(
    'wrong output',
  );
});
