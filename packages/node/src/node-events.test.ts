import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeLoopTransport } from './node-loop.js';
import { subscribeEvent } from './node-events.js';

/** drainEvents 폴링 어댑터를 위한 큐 기반 fake transport. */
function fakeTransport(eventsByPoll: Array<Array<{ name: string; payload: unknown }>>) {
  let poll = 0;
  const drains: number[] = [];
  const transport = {
    invoke() {
      return Promise.resolve(null);
    },
    drainEvents() {
      drains.push(poll);
      const batch = eventsByPoll[poll] ?? [];
      poll += 1;
      return Promise.resolve(batch);
    },
    dispose() {},
    get pid() {
      return null;
    },
  } satisfies NodeLoopTransport;
  return { transport, drains };
}

/** 폴링 간격을 0으로 압축해 테스트를 즉시 진행시킨다. */
function useFastPolling() {
  const previous = process.env.RUSTRA_NODE_EVENT_POLL_MS;
  process.env.RUSTRA_NODE_EVENT_POLL_MS = '0';
  return () => {
    if (previous === undefined) delete process.env.RUSTRA_NODE_EVENT_POLL_MS;
    else process.env.RUSTRA_NODE_EVENT_POLL_MS = previous;
  };
}

test('subscribeEvent delivers drained events to the matching callback', async () => {
  const restore = useFastPolling();
  try {
    const { transport } = fakeTransport([
      [],
      [
        { name: 'progress.tick', payload: { step: 1 } },
        { name: 'demo.done', payload: { emitted: 3 } },
      ],
    ]);
    const ticks: unknown[] = [];
    const dones: unknown[] = [];
    subscribeEvent(transport, 'progress.tick', (p) => ticks.push(p));
    subscribeEvent(transport, 'demo.done', (p) => dones.push(p));

    await waitFor(() => ticks.length >= 1 && dones.length >= 1);
    assert.deepEqual(ticks, [{ step: 1 }]);
    assert.deepEqual(dones, [{ emitted: 3 }]);
  } finally {
    restore();
  }
});

test('subscribeEvent keeps delivering while at least one subscriber remains', async () => {
  const restore = useFastPolling();
  try {
    // 이후 폴링마다 계속 이벤트가 나온다(마지막 배치 반복).
    const { transport } = fakeTransport([
      [{ name: 'tick', payload: 1 }],
      [{ name: 'tick', payload: 2 }],
      [{ name: 'tick', payload: 3 }],
    ]);
    const seen: unknown[] = [];
    const unsubscribeA = subscribeEvent(transport, 'tick', (p) => seen.push(`a:${String(p)}`));
    subscribeEvent(transport, 'tick', (p) => seen.push(`b:${String(p)}`));

    await waitFor(() => seen.filter((e) => String(e).startsWith('b:')).length >= 2);
    unsubscribeA();
    assert.ok(
      seen.some((e) => String(e).startsWith('a:')),
      'A received before unsubscribing',
    );
    assert.ok(
      seen.some((e) => String(e).startsWith('b:')),
      'B keeps receiving',
    );
  } finally {
    restore();
  }
});

test('subscribeEvent stops polling when the last subscriber unsubscribes', async () => {
  const restore = useFastPolling();
  const { transport, drains } = fakeTransport([[{ name: 'tick', payload: 1 }], [], [], []]);
  const seen: unknown[] = [];
  const unsubscribe = subscribeEvent(transport, 'tick', (p) => seen.push(p));
  await waitFor(() => drains.length >= 1);
  // 이벤트 전달은 구독 중에 일어났어야 한다.
  assert.deepEqual(seen, [1]);
  unsubscribe();
  await sleep(20);
  const totalDrains = drains.length;
  await sleep(20);
  assert.equal(drains.length, totalDrains, 'no more polling after the last unsubscribe');
  restore();
});

test('subscribeEvent shares one polling loop across separate subscribe calls', async () => {
  const restore = useFastPolling();
  try {
    const { transport, drains } = fakeTransport([
      [{ name: 'x', payload: null }],
      [],
      [{ name: 'y', payload: null }],
    ]);
    const gotX: unknown[] = [];
    const gotY: unknown[] = [];
    const unX = subscribeEvent(transport, 'x', (p) => gotX.push(p));
    const unY = subscribeEvent(transport, 'y', (p) => gotY.push(p));

    await waitFor(() => gotX.length >= 1 && gotY.length >= 1);
    unX();
    unY();
    assert.ok(drains.length >= 1, 'both subscribers shared the same drain source');
  } finally {
    restore();
  }
});

test('subscribeEvent survives a synchronous drainEvents throw', async () => {
  const restore = useFastPolling();
  try {
    let calls = 0;
    const transport = {
      invoke() {
        return Promise.resolve(null);
      },
      drainEvents() {
        calls += 1;
        if (calls === 1) throw new Error('sync boom');
        return Promise.resolve([{ name: 'ok', payload: 1 }]);
      },
      dispose() {},
      get pid() {
        return null;
      },
    } satisfies NodeLoopTransport;
    const got: unknown[] = [];
    subscribeEvent(transport, 'ok', (p) => got.push(p));
    await waitFor(() => got.length >= 1);
    assert.ok(calls >= 2, 'polling continued after a synchronous drain failure');
  } finally {
    restore();
  }
});

// ── helpers ──────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor timed out');
}
