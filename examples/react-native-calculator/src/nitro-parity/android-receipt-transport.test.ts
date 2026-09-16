import { expect, test } from 'bun:test';
import { emitAndroidReceiptChunks } from './android-receipt-transport';
import { extractAndroidReceipt } from '../../scripts/parity-android-chunks';

const chunk = (line: string) => JSON.parse(line.slice('RUSTRA_PARITY_CHUNK='.length));
test('next chunk cannot emit until the preceding 10ms delay resolves', async () => {
  const emitted: string[] = [],
    delays: number[] = [],
    release: (() => void)[] = [];
  const json = JSON.stringify({ runId: 'gated', value: 'x'.repeat(4500) });
  const done = emitAndroidReceiptChunks(
    json,
    'gated',
    (line) => emitted.push(line),
    (ms) => {
      delays.push(ms);
      return new Promise<void>((resolve) => release.push(resolve));
    },
  );
  expect(emitted).toHaveLength(1);
  expect(delays).toEqual([10]);
  release[0]();
  await Promise.resolve();
  expect(emitted).toHaveLength(2);
  expect(delays).toEqual([10, 10]);
  release[1]();
  await Promise.resolve();
  expect(emitted).toHaveLength(3);
  expect(delays).toEqual([10, 10, 10]);
  release[2]();
  await done;
  expect(emitted.map(chunk).map((c) => c.index)).toEqual([0, 1, 2]);
  expect(
    emitted
      .map(chunk)
      .map((c) => c.text)
      .join(''),
  ).toBe(json);
});
test('empty input emits no chunks or delays', async () => {
  const emitted: string[] = [],
    delays: number[] = [];
  await emitAndroidReceiptChunks(
    '',
    'empty',
    (line) => emitted.push(line),
    async (ms) => {
      delays.push(ms);
    },
  );
  expect(emitted).toEqual([]);
  expect(delays).toEqual([]);
});
test.each(['short', 'unicode'] as const)(
  '%s JSON preserves exact schema, order, contents and parser reconstruction',
  async (kind) => {
    const runId = kind;
    const prefix = JSON.stringify({ runId, value: '' }).length - 2;
    // Place a surrogate pair across the exact 2000-code-unit boundary.
    const value =
      kind === 'short' ? '한글 😀' : '가'.repeat(1999 - prefix) + '😀' + '다'.repeat(4100);
    const receipt = { runId, value },
      json = JSON.stringify(receipt),
      emitted: string[] = [],
      delays: number[] = [];
    await emitAndroidReceiptChunks(
      json,
      runId,
      (line) => emitted.push(line),
      async (ms) => {
        delays.push(ms);
      },
    );
    const total = Math.ceil(json.length / 2000);
    expect(emitted).toHaveLength(total);
    expect(delays).toEqual(Array(total).fill(10));
    emitted.forEach((line, index) =>
      expect(chunk(line)).toEqual({
        runId,
        index,
        total,
        text: json.slice(index * 2000, (index + 1) * 2000),
      }),
    );
    expect(
      emitted
        .map(chunk)
        .map((c) => c.text)
        .join(''),
    ).toBe(json);
    expect(extractAndroidReceipt(emitted.join('\n'))).toEqual(receipt);
    if (total > 1) expect(extractAndroidReceipt(emitted.slice(0, -1).join('\n'))).toBeUndefined();
  },
);
