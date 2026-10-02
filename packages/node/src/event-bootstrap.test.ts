import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, ensureConfigured } from '@rustra/types';
import { createNodeBootstrap, type NodeProcessTransport } from './index.js';

const processTest = process.versions.bun ? test.skip : test;
const script = String.raw`
  const readline = require('node:readline');
  let count = 0;
  const events = [];
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, command } = JSON.parse(line);
    let response;
    if (command === '__rustra_contract') response = { result: 'valid-contract' };
    else if (command === '__rustra_capabilities') response = { result: { events: 'polling' } };
    else if (command === '__drainEvents') response = { events: events.splice(0) };
    else {
      events.push({ name: 'tick', payload: ++count });
      response = { result: { count, pid: process.pid } };
    }
    process.stdout.write(JSON.stringify({ id, ok: true, ...response }) + '\n');
  });
`;

processTest(
  'a persistent bootstrap shares command state and emitted events in one runtime',
  async () => {
    configure({ invoke: async <T>() => null as T });
    const options = {
      command: process.execPath,
      args: ['-e', script],
      contractHash: 'valid-contract',
      persistent: true,
    };
    const bootstrap = createNodeBootstrap(options);
    const events: unknown[] = [];
    try {
      const unsubscribe = bootstrap.subscribeEvent('tick', (payload) => events.push(payload));
      const engine = await bootstrap.ready();
      const first = await engine.invoke<{ count: number; pid: number }>('emit');
      const second = await engine.invoke<{ count: number; pid: number }>('emit');
      assert.deepEqual([first.count, second.count], [1, 2]);
      assert.equal(first.pid, second.pid);
      await waitFor(() => events.length === 2);
      assert.deepEqual(events, [1, 2]);
      unsubscribe();
      await engine.invoke('emit');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(events, [1, 2]);
    } finally {
      bootstrap.dispose();
    }
  },
);

processTest(
  'subscribing after a generated call initializes the runtime attaches immediately',
  async () => {
    configure({ invoke: async <T>() => null as T });
    const bootstrap = createNodeBootstrap({
      command: process.execPath,
      args: ['-e', script],
      persistent: true,
    });
    const events: unknown[] = [];
    try {
      const engine = await ensureConfigured();
      bootstrap.subscribeEvent('tick', (payload) => events.push(payload));
      await engine.invoke('emit');
      await waitFor(() => events.length === 1);
      assert.deepEqual(events, [1]);
    } finally {
      bootstrap.dispose();
    }
  },
);

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('event delivery timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('an old bootstrap unsubscribe cannot remove a replacement using the same callback', async () => {
  configure({ invoke: async <T>() => null as T });
  const handlers = new Set<(event: { name: string; payload: string }) => void>();
  const transport: NodeProcessTransport & {
    onPushEvent(handler: (event: { name: string; payload: string }) => void): () => void;
  } = {
    invoke: async () => null,
    getContractHash: async () => '',
    pid: null,
    dispose() {
      handlers.clear();
    },
    onPushEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  const bootstrap = createNodeBootstrap({ createTransport: () => transport });
  const seen: unknown[] = [];
  const callback = (payload: never) => seen.push(payload);
  try {
    await bootstrap.ready();
    const old = bootstrap.subscribeEvent('tick', callback);
    old();
    const next = bootstrap.subscribeEvent('tick', callback);
    old();
    for (const handler of handlers) handler({ name: 'tick', payload: '1' });
    assert.deepEqual(seen, [1]);
    next();
  } finally {
    bootstrap.dispose();
  }
});

processTest(
  'persistent readiness rejects a silent runtime within its configured deadline',
  async () => {
    configure({ invoke: async <T>() => null as T });
    const options = {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      contractHash: 'expected',
      persistent: true,
      readinessTimeoutMs: 20,
    };
    const bootstrap = createNodeBootstrap(options);
    const attempt = bootstrap.ready().catch((error: unknown) => error);
    try {
      const result = await Promise.race([
        attempt,
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 150)),
      ]);
      assert.ok(result instanceof Error, String(result));
      assert.match(result.message, /timed out/);
    } finally {
      bootstrap.dispose();
      await attempt;
    }
  },
);
