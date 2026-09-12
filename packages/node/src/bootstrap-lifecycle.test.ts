import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, ensureConfigured, invoke } from '@rustra/types';
import { createNodeBootstrap, createNodeProcessTransport } from './index.js';

const clean = () => configure({ invoke: async <T>() => 'replacement' as T });

test('ready racing a reload never succeeds with the closed previous engine', async () => {
  clean();
  let version = 0;
  const b = createNodeBootstrap({ createTransport: () => transport(String(++version)) });
  await b.ready();
  const reloading = b.reload();
  const rejected = assert.rejects(b.ready(), /superseded/);
  await Promise.all([reloading, rejected]);
  assert.equal(await (await b.ready()).invoke('ping'), '2');
  b.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function transport(value = 'live') {
  return {
    closes: 0,
    calls: 0,
    pid: null,
    async invoke() {
      this.calls++;
      return value;
    },
    async getContractHash() {
      return 'hash';
    },
    dispose() {
      this.closes++;
    },
  };
}

test('disposal releases an unconsumed registration and protects replacements', async () => {
  clean();
  const first = createNodeBootstrap({ createTransport: () => transport() });
  first.dispose();
  const second = createNodeBootstrap({ createTransport: () => transport('second') });
  first.dispose();
  assert.equal(await (await second.ready()).invoke('ping'), 'second');
  clean();
  second.dispose();
  assert.equal(await invoke('ping'), 'replacement');
});

test('late transport is closed once and never installed after dispose', async () => {
  clean();
  const gate = deferred<ReturnType<typeof transport>>();
  const started = deferred<void>();
  const t = transport();
  const b = createNodeBootstrap({
    createTransport: () => {
      started.resolve();
      return gate.promise;
    },
  });
  const pending = b.ready();
  const rejected = assert.rejects(pending, /disposed/);
  await started.promise;
  b.dispose();
  gate.resolve(t);
  await rejected;
  assert.equal(t.closes, 1);
  b.dispose();
  assert.equal(t.closes, 1);
  await assert.rejects(ensureConfigured(), /not configured/i);
});

for (const fail of [false, true])
  test(`contract ${fail ? 'rejection' : 'success'} after disposal closes once without masking error`, async () => {
    clean();
    const gate = deferred<string>();
    const started = deferred<void>();
    const t = transport();
    t.getContractHash = () => {
      started.resolve();
      return gate.promise;
    };
    const b = createNodeBootstrap({ contractHash: 'hash', createTransport: () => t });
    const rejected = assert.rejects(b.ready(), /disposed/);
    await started.promise;
    b.dispose();
    if (fail) gate.reject(new Error('closed'));
    else gate.resolve('hash');
    await rejected;
    assert.equal(t.closes, 1);
  });

test('disposal wins every handshake-to-install microtask boundary', async () => {
  for (let ticks = 0; ticks <= 8; ticks++) {
    clean();
    const gate = deferred<string>();
    const started = deferred<void>();
    const t = transport();
    t.getContractHash = () => {
      started.resolve();
      return gate.promise;
    };
    const b = createNodeBootstrap({ contractHash: 'hash', createTransport: () => t });
    const pending = b.ready().catch(() => undefined);
    await started.promise;
    gate.resolve('hash');
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    b.dispose();
    await pending;
    await assert.rejects(ensureConfigured(), /not configured/i);
    assert.equal(t.closes, 1);
  }
});

test('overlapping reloads share one resource and invalidate the old engine', async () => {
  clean();
  const initial = transport();
  const next = transport('next');
  const gate = deferred<ReturnType<typeof transport>>();
  let starts = 0;
  const b = createNodeBootstrap({
    createTransport: () => (++starts === 1 ? initial : gate.promise),
  });
  const old = await b.ready();
  const first = b.reload();
  const second = b.reload();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  gate.resolve(next);
  await Promise.all([first, second]);
  await assert.rejects(old.invoke('ping'), /disposed/);
  const engine = await b.ready();
  assert.equal(await engine.invoke('ping'), 'next');
  b.dispose();
  await assert.rejects(engine.invoke('ping'), /disposed/);
  await assert.rejects(engine.invokeBatch([]), /disposed/);
  assert.equal(initial.closes, 1);
  assert.equal(next.closes, 1);
});

test('reload during initial readiness waits for the first owned resource', async () => {
  clean();
  const gate = deferred<ReturnType<typeof transport>>();
  const started = deferred<void>();
  const initial = transport();
  const next = transport('next');
  let starts = 0;
  const b = createNodeBootstrap({
    createTransport: () => {
      starts++;
      started.resolve();
      return starts === 1 ? gate.promise : next;
    },
  });
  const ready = b.ready();
  await started.promise;
  const reload = b.reload();
  gate.resolve(initial);
  await ready;
  await reload;
  assert.equal(starts, 2);
  assert.equal(initial.closes, 1);
  b.dispose();
  assert.equal(next.closes, 1);
});

test('a bootstrap never returns another registration engine from ready', async () => {
  clean();
  const t = transport();
  const b = createNodeBootstrap({ createTransport: () => t });
  clean();
  await assert.rejects(b.ready(), /replaced|ownership|registration/i);
  b.dispose();
  assert.equal(await invoke('ping'), 'replacement');
});

test('disposed process transport rejects invocation and contract lookup without spawning', async () => {
  const t = createNodeProcessTransport({
    command: 'node',
    args: [
      '-e',
      'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({ok:true,result:"zombie"})))',
    ],
  });
  t.dispose();
  await assert.rejects(
    Promise.resolve().then(() => t.invoke('ping')),
    /disposed/,
  );
  await assert.rejects(t.getContractHash(), /disposed/);
  assert.equal(t.pid, null);
});

test('ownership loss at the install boundary closes the rejected ready resource', async () => {
  for (let ticks = 0; ticks <= 5; ticks++) {
    clean();
    const t = transport();
    const gate = deferred<string>();
    const started = deferred<void>();
    t.getContractHash = () => {
      started.resolve();
      return gate.promise;
    };
    const b = createNodeBootstrap({ contractHash: 'hash', createTransport: () => t });
    const pending = b.ready().catch((error: unknown) => error);
    await started.promise;
    gate.resolve('hash');
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    clean();
    const result = await pending;
    if (result instanceof Error) assert.equal(t.closes, 1);
    b.dispose();
    assert.equal(t.closes, 1);
    assert.equal(await invoke('ping'), 'replacement');
  }
});

test(
  'process disposal rejects every concurrent child invocation',
  { skip: Boolean(process.versions.bun) },
  async () => {
    const t = createNodeProcessTransport({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>console.log(JSON.stringify({ok:true,result:"late"})),100)'],
    });
    const first = assert.rejects(Promise.resolve(t.invoke('first')), /disposed/);
    const second = assert.rejects(Promise.resolve(t.invoke('second')), /disposed/);
    t.dispose();
    await Promise.all([first, second]);
    assert.equal(t.pid, null);
  },
);
