import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as api from './index.js';
import type { FrameCodec, FrameSchemaNative } from './index.js';

const wire = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
function setup(overrides: Record<string, unknown> = {}) {
  let calls = 0;
  const state = {
    generation: 1,
    frozen: true,
    execution: 'sync',
    id: 7,
    hash: 'matching-contract',
  };
  const codec = {
    commandId: 7,
    execution: 'sync',
    syncFields: ['a', 'b'],
    encode: (args: unknown) => wire(args),
    decode: (bytes: ArrayBuffer) => ({
      ok: true,
      result: JSON.parse(new TextDecoder().decode(bytes)),
    }),
  } as FrameCodec<unknown, unknown>;
  const native: FrameSchemaNative = {
    getContractHash: () => new TextEncoder().encode(state.hash).buffer,
    getSchemaGeneration: () => state.generation,
    getSchema: () =>
      wire({
        schemaGeneration: state.generation,
        registryFrozen: state.frozen,
        commands: [{ name: 'add', commandId: state.id, execution: state.execution }],
      }),
    invokeFrame: (bytes) => {
      calls++;
      const args = JSON.parse(new TextDecoder().decode(bytes));
      return wire({ value: args.a + args.b });
    },
    getCodecCapabilities: () => 3,
    invokeTypedById: (_id, args) => {
      calls++;
      const { a, b } = args as { a: number; b: number };
      return { value: a + b };
    },
    invokeTypedPos: (_id, a, b) => {
      calls++;
      return { value: Number(a) + Number(b) };
    },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'bindSyncCommand'))
    native.bindSyncCommand = (id, name, expected, route) => {
      const validate = () => {
        if (
          state.execution !== 'sync' ||
          !state.frozen ||
          state.id !== id ||
          state.hash !== expected ||
          name !== 'add'
        )
          throw new Error('sync.unavailable: native metadata rejected');
      };
      validate();
      return (input, a, b, c) => {
        validate();
        const capabilities = native.getCodecCapabilities?.(id) ?? 0;
        if (route === 4 && capabilities & 8 && a && !Array.isArray(a))
          return native.invokeTypedBuffer!(id, a as Uint8Array);
        if (route >= 1 && route <= 3 && capabilities & 4) {
          const value = native.invokeTypedRaw!(id, a, b, c);
          if (!(typeof value === 'number' && Number.isNaN(value))) return value;
        }
        if (route && capabilities & 2) return native.invokeTypedPos!(id, a, b, c);
        return native.invokeTypedById!(id, input);
      };
    };
  const engine = api.createFrameEngine(native, new Map([['add', codec]]), {
    contractHash: 'matching-contract',
    contractVerification: 'off',
  });
  const release = api.configure(engine);
  return { state, codec, native, engine, release, calls: () => calls };
}
const bind = () => {
  assert.equal(typeof api.bindSync, 'function', 'public bindSync is available');
  return api.bindSync<{ a: number; b: number }, { value: number }>('add');
};

test('sync binding returns a direct result and keeps the existing Promise API', async () => {
  const x = setup();
  const add = bind();
  assert.deepEqual(add({ a: 2, b: 3 }), { value: 5 });
  assert.equal(x.calls(), 1);
  const pending = x.engine.invoke('add', { a: 4, b: 3 });
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, { value: 7 });
  x.release();
});

test('unknown, async, unfrozen and mismatched commands never dispatch through a sync binding', () => {
  for (const change of [
    (x: ReturnType<typeof setup>) => {
      x.state.execution = 'async';
    },
    (x: ReturnType<typeof setup>) => {
      x.state.execution = 'unknown';
    },
    (x: ReturnType<typeof setup>) => {
      delete x.codec.execution;
    },
    (x: ReturnType<typeof setup>) => {
      x.state.frozen = false;
    },
    (x: ReturnType<typeof setup>) => {
      x.state.id = 8;
    },
    (x: ReturnType<typeof setup>) => {
      x.state.hash = 'different';
    },
  ]) {
    const x = setup();
    change(x);
    assert.throws(
      () => bind(),
      (e: unknown) => e instanceof api.RustraCommandError && e.code === 'sync.unavailable',
    );
    assert.equal(x.calls(), 0);
    x.release();
  }
});

test('bindings rebind after configure and reject disposed or asynchronous transports', () => {
  const a = setup();
  const call = bind();
  const b = setup({ invokeTypedPos: () => ({ value: 99 }) });
  assert.deepEqual(call({ a: 1, b: 2 }), { value: 99 });
  assert.equal(a.calls(), 0);
  b.release();
  assert.throws(() => call({ a: 1, b: 2 }), /sync|configured/i);
  const release = api.configure({ invoke: async <T>() => ({ value: 0 }) as T });
  assert.throws(() => bind(), /sync/i);
  release();
});

test('changed or unavailable native generation rejects before executing a handler', () => {
  const x = setup();
  const call = bind();
  x.state.generation++;
  x.state.execution = 'async';
  assert.throws(
    () => call({ a: 1, b: 2 }),
    (e: unknown) => e instanceof api.RustraCommandError && e.code === 'sync.unavailable',
  );
  assert.equal(x.calls(), 0);
  x.release();
  const y = setup({ bindSyncCommand: undefined });
  assert.throws(() => bind(), /sync/i);
  assert.equal(y.calls(), 0);
  y.release();
});

test('getters can reenter the same binding without shared argument storage', () => {
  const x = setup();
  const call = bind();
  let reads = 0;
  const input = {
    get a() {
      reads++;
      assert.deepEqual(call({ a: 10, b: 20 }), { value: 30 });
      return 4;
    },
    b: 5,
  };
  assert.deepEqual(call(input), { value: 9 });
  assert.equal(reads, 1);
  assert.equal(x.calls(), 2);
  x.release();
});

test('native errors throw once synchronously and the existing API still rejects', async () => {
  let calls = 0;
  const fail = () => {
    calls++;
    throw new Error('math.failed: failure');
  };
  const x = setup({ invokeTypedPos: fail, invokeTypedById: fail });
  const call = bind();
  assert.throws(
    () => call({ a: 1, b: 2 }),
    (e: unknown) => e instanceof api.RustraCommandError && e.code === 'math.failed',
  );
  assert.equal(calls, 1);
  await assert.rejects(x.engine.invoke('add', { a: 1, b: 2 }));
  assert.equal(calls, 2);
  x.release();
});

test('a JS-codec-only host is refused rather than pretending its probes are atomic', () => {
  const x = setup({ bindSyncCommand: undefined });
  assert.throws(
    () => bind(),
    (e: unknown) => e instanceof api.RustraCommandError && e.code === 'sync.unavailable',
  );
  assert.equal(x.calls(), 0);
  x.release();
});

test('a missing generated command has a command error and lazy setup is never consumed', () => {
  const x = setup();
  assert.throws(
    () => api.bindSync('absent'),
    (e: unknown) => e instanceof api.RustraCommandError && e.code === 'command.not_found',
  );
  x.release();
  let starts = 0;
  const release = api.configureLazy(() => {
    starts++;
    return x.engine;
  });
  assert.throws(() => bind(), /sync/i);
  assert.equal(starts, 0);
  release();
});

test('raw unavailable marker falls back once while successful output keeps its public shape', () => {
  let raw = 0,
    pos = 0;
  const x = setup({
    getCodecCapabilities: () => 7,
    invokeTypedRaw: () => {
      raw++;
      return NaN;
    },
    invokeTypedPos: (_id: number, a: number, b: number) => {
      pos++;
      return { value: a + b };
    },
  });
  const call = bind();
  assert.deepEqual(call({ a: 3, b: 4 }), { value: 7 });
  assert.equal(raw, 1);
  assert.equal(pos, 1);
  x.release();
});

test('native byte route receives the exact view and returns independent owned output', () => {
  const x = setup({
    getCodecCapabilities: () => 9,
    invokeTypedBuffer: (_id: number, value: Uint8Array) => ({ data: value.slice() }),
  });
  x.codec.syncByteField = 'data';
  x.codec.syncFields = ['data'];
  const call = api.bindSync<{ data: Uint8Array }, { data: Uint8Array }>('add');
  const storage = new Uint8Array([9, 1, 2, 9]),
    input = { data: storage.subarray(1, 3) };
  const out = call(input);
  assert.deepEqual([...out.data], [1, 2]);
  assert.notEqual(out.data.buffer, storage.buffer);
  x.release();
});
