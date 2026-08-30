import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { createJsonEngine, decodeUtf8, encodeUtf8, exactArrayBuffer } from './index.js';

test('shared runtime helpers are available from the package facade', async () => {
  const text = 'Rustra 한글 🚀';
  assert.equal(decodeUtf8(encodeUtf8(text)), text);

  const view = new Uint8Array([1, 2, 3]).subarray(1);
  assert.deepEqual(Array.from(new Uint8Array(exactArrayBuffer(view))), [2, 3]);

  const engine = createJsonEngine(async () => ({ ok: true }));
  assert.deepEqual(await engine.invoke('health'), { ok: true });
});

// ── json-engine 와이어 배치 위임 (트랙 E2) ───────────────────

test('json-engine delegates invokeBatch to transport wire batch when offered', async () => {
  const batchRequests: Array<Array<{ command: string; args?: unknown }>> = [];
  let singleCalls = 0;
  const engine = createJsonEngine({
    invoke: () => {
      singleCalls += 1;
      return { unreachable: true };
    },
    invokeBatch: (requests) => {
      batchRequests.push(requests.map((r) => ({ command: r.command, args: r.args })));
      return requests.map((r) => (r.command === 'add' ? { value: 42 } : { v: 1 }));
    },
  });
  const out = await engine.invokeBatch<Array<{ value: number } | { v: number }>>([
    { command: 'add', args: { a: 20, b: 22 } },
    { command: 'mul', args: { a: 2, b: 3 } },
    { command: 'add', args: { a: 1, b: 1 } },
  ]);
  assert.equal(singleCalls, 0, 'per-entry invoke must not run on the wire batch path');
  assert.equal(batchRequests.length, 1, 'wire batch must be a single transport crossing');
  assert.deepEqual(batchRequests[0], [
    { command: 'add', args: { a: 20, b: 22 } },
    { command: 'mul', args: { a: 2, b: 3 } },
    { command: 'add', args: { a: 1, b: 1 } },
  ]);
  assert.deepEqual(out, [{ value: 42 }, { v: 1 }, { value: 42 }]);
});

test('json-engine falls back to Promise.all when transport offers no wire batch', async () => {
  const calls: string[] = [];
  const engine = createJsonEngine({
    invoke: (command: string) => {
      calls.push(command);
      return { echo: command };
    },
  });
  const out = await engine.invokeBatch<Array<{ echo: string }>>([
    { command: 'a', args: {} },
    { command: 'b', args: {} },
  ]);
  assert.deepEqual(out, [{ echo: 'a' }, { echo: 'b' }]);
  assert.deepEqual(calls.sort(), ['a', 'b']);
});

test('json-engine routes entries carrying options off the wire batch', async () => {
  // 항목별 options(signal/timeoutMs)는 와이어 배치가 표현할 수 없는 개별
  // 정책이다 — 하나라도 있으면 Promise.all 폴백으로 항목별 옵션을 존중한다.
  let batchCalls = 0;
  const ac = new AbortController();
  ac.abort();
  const engine = createJsonEngine({
    invoke: () => ({ ok: true }),
    invokeBatch: () => {
      batchCalls += 1;
      return [];
    },
  });
  await assert.rejects(
    engine.invokeBatch([{ command: 'a', args: {}, options: { signal: ac.signal } }]),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(batchCalls, 0, 'option-carrying entries must not ride the wire batch');
});

test('json-engine still accepts the plain function transport form', async () => {
  const engine = createJsonEngine(async () => ({ ok: true }));
  assert.deepEqual(await engine.invoke('health'), { ok: true });
});
