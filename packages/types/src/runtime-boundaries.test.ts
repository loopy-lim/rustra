import assert from 'node:assert/strict';
import { test } from 'bun:test';

import {
  createFrameEngine,
  createJsonEngine,
  decodeUtf8,
  encodeUtf8,
  exactArrayBuffer,
} from './index.js';
import type { FrameCodec } from './index.js';

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

// F02: cleanup is tied to a registration, including the pending-to-ready transition.
test('registration cleanup removes its installed engine without clearing a replacement', async () => {
  const { configure, configureLazy, ensureConfigured } = await import('./global-config.js');
  configure({ invoke: async <T>() => null as T });
  const release = configureLazy(() => ({ invoke: async <T>() => 'owned' as T }));
  await ensureConfigured();
  assert.equal(typeof release, 'function');
  release();
  await assert.rejects(ensureConfigured(), /not configured/i);
  const oldRelease = configureLazy(() => ({ invoke: async <T>() => 'old' as T }));
  const replacement = { invoke: async <T>() => 'new' as T };
  configure(replacement);
  oldRelease();
  assert.equal(await ensureConfigured(), replacement);
});

function reusableBytesCodec(offset = 0): FrameCodec<unknown, number[]> {
  return {
    commandId: 1,
    encode(args) {
      assert.ok(Array.isArray(args));
      return Uint8Array.from(args).buffer;
    },
    encodeInto(args, reuse) {
      assert.ok(Array.isArray(args));
      const capacity = Math.max(64, offset + args.length);
      const out =
        reuse && reuse.buffer.byteLength >= capacity
          ? new Uint8Array(reuse.buffer)
          : new Uint8Array(capacity);
      out.fill(199);
      out.set(args, offset);
      return out.subarray(offset, offset + args.length);
    },
    decode(frame) {
      const bytes =
        frame instanceof ArrayBuffer
          ? new Uint8Array(frame)
          : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
      return { ok: true, result: Array.from(bytes) };
    },
  };
}

for (const offset of [0, 3]) {
  test(`frame encodeInto reuses exact transport buffers across stable lengths at offset ${offset}`, async () => {
    const received: ArrayBuffer[] = [];
    const engine = createFrameEngine(
      {
        invokeFrame(request) {
          received.push(request);
          return request;
        },
      },
      new Map([['bytes', reusableBytesCodec(offset)]]),
    );
    const lengths = [4, 4, 80, 80, 2, 2, 0, 0, 64, 64];
    for (let i = 0; i < lengths.length; i++) {
      const args = Array.from({ length: lengths[i] }, (_, j) => (i + j) % 128);
      assert.deepEqual(await engine.invoke('bytes', args), args);
      assert.equal(received[i].byteLength, args.length, 'native must see exact frame length');
      if (i % 2 === 1) {
        assert.equal(received[i], received[i - 1], 'stable lengths must reuse the ArrayBuffer');
      }
    }
  });
}

test('frame encodeInto releases reusable buffers after native and decode errors', async () => {
  const nativeError = new Error('native failed');
  const decodeError = new Error('decode failed');
  const encodeError = new Error('encode failed');
  const received: ArrayBuffer[] = [];
  const codec = reusableBytesCodec();
  const encodeInto = codec.encodeInto!;
  const decode = codec.decode;
  let failure: 'native' | 'decode' | 'outcome' | 'encode' | undefined;
  codec.encodeInto = (args, reuse) => {
    if (failure === 'encode') throw encodeError;
    return encodeInto(args, reuse);
  };
  codec.decode = (frame) => {
    if (failure === 'decode') throw decodeError;
    if (failure === 'outcome')
      return { ok: false, error: { code: 'invoke.failed', message: 'denied' } };
    return decode(frame);
  };
  const engine = createFrameEngine(
    {
      invokeFrame(request) {
        received.push(request);
        if (failure === 'native') throw nativeError;
        return request;
      },
    },
    new Map([['bytes', codec]]),
  );
  await engine.invoke('bytes', [1, 2, 3, 4]);
  for (const [kind, error] of [
    ['native', nativeError],
    ['decode', decodeError],
    ['encode', encodeError],
  ] as const) {
    failure = kind;
    await assert.rejects(engine.invoke('bytes', [5, 6, 7, 8]), (actual) => actual === error);
    failure = undefined;
    assert.deepEqual(await engine.invoke('bytes', [9, 10, 11, 12]), [9, 10, 11, 12]);
  }
  failure = 'outcome';
  await assert.rejects(engine.invoke('bytes', [1, 2, 3, 4]), /denied/);
  failure = undefined;
  await engine.invoke('bytes', [2, 3, 4, 5]);
  for (const request of received) assert.equal(request, received[0]);
});

for (const length of [4, 64]) {
  test(`frame encodeInto keeps ${length}-byte request intact during synchronous reentry`, async () => {
    const outerArgs = Array.from({ length }, (_, i) => i + 1);
    const nestedArgs = Array.from({ length }, (_, i) => i + 9);
    const requests: ArrayBuffer[] = [];
    let nested: Promise<unknown> | undefined;
    const engine = createFrameEngine(
      {
        invokeFrame(request) {
          requests.push(request);
          const consumed = Array.from(new Uint8Array(request));
          if (consumed[0] === 1) {
            nested = engine.invoke('bytes', nestedArgs);
            assert.deepEqual(Array.from(new Uint8Array(request)), consumed);
          }
          return request;
        },
      },
      new Map([['bytes', reusableBytesCodec()]]),
    );
    assert.deepEqual(await engine.invoke('bytes', outerArgs), outerArgs);
    assert.deepEqual(await nested, nestedArgs);
    assert.notEqual(requests[0], requests[1], 'active request cannot be borrowed by reentry');
    await engine.invoke('bytes', nestedArgs);
    assert.equal(requests[2], requests[0], 'outer buffer returns to the reusable slot');
  });
}
