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
    get mode() {
      return 'ndjson' as const;
    },
    get pushCapable() {
      return false;
    },
    ready() {
      return Promise.resolve();
    },
    drain() {
      return Promise.resolve();
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
      get mode() {
        return 'ndjson' as const;
      },
      get pushCapable() {
        return false;
      },
      ready() {
        return Promise.resolve();
      },
      drain() {
        return Promise.resolve();
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

// ── 2-모드 dispatch (push 우선, 폴링 폴백) ─────────────────────

/** push 능력을 노출하는 transport — drainEvents 는 호출되어야 실패한다. */
function pushTransport() {
  const listeners = new Set<(event: { name: string; payload: string }) => void>();
  let drains = 0;
  const transport = {
    invoke() {
      return Promise.resolve(null);
    },
    drainEvents() {
      drains += 1;
      return Promise.resolve([] as Array<{ name: string; payload: unknown }>);
    },
    onPushEvent(handler: (event: { name: string; payload: string }) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    emit(name: string, payload: string) {
      for (const listener of [...listeners]) listener({ name, payload });
    },
    dispose() {},
    get pid() {
      return null;
    },
    get mode() {
      return 'binary' as const;
    },
    get pushCapable() {
      return true;
    },
    ready() {
      return Promise.resolve();
    },
    drain() {
      return Promise.resolve();
    },
    /** 테스트 관찰용. */
    get drainCount() {
      return drains;
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return transport;
}

test('push-capable transport subscribes via push without starting the polling loop', async () => {
  const transport = pushTransport();
  const got: unknown[] = [];
  const unsubscribe = subscribeEvent(transport as never, 'progress.tick', (p) => got.push(p));
  // 푸시 도착 — 폴링 틱 없이 즉시 전달된다.
  transport.emit('progress.tick', '{"step":1}');
  await waitFor(() => got.length >= 1);
  assert.deepEqual(got, [{ step: 1 }]);
  assert.equal(transport.drainCount, 0, 'polling loop must not start for push transports');
  unsubscribe();
  assert.equal(transport.listenerCount, 0, 'unsubscribe removes the push listener');
});

test('push-capable transport parses payload string JSON and shares one push subscription', async () => {
  const transport = pushTransport();
  const a: unknown[] = [];
  const b: unknown[] = [];
  const unA = subscribeEvent(transport as never, 'tick', (p) => a.push(p));
  const unB = subscribeEvent(transport as never, 'tick', (p) => b.push(p));
  transport.emit('tick', '{"n":7}');
  await waitFor(() => a.length >= 1 && b.length >= 1);
  assert.deepEqual(a, [{ n: 7 }]);
  assert.deepEqual(b, [{ n: 7 }]);
  assert.equal(transport.listenerCount, 1, 'one transport-level listener serves both callbacks');
  unA();
  unB();
  assert.equal(transport.listenerCount, 0);
});

test('push-capable transport survives a throwing listener', async () => {
  const transport = pushTransport();
  const got: unknown[] = [];
  subscribeEvent(transport as never, 'tick', () => {
    throw new Error('listener boom');
  });
  subscribeEvent(transport as never, 'tick', (p) => got.push(p));
  transport.emit('tick', '{"n":1}');
  await waitFor(() => got.length >= 1);
  assert.deepEqual(got, [{ n: 1 }]);
});

test('subscribeEvent throws loudly when the transport cannot deliver events', () => {
  // 이슈 A — 페어링 갭: drain 도 push 능력도 없는 transport(예: one-shot
  // invoke 바이너리에 붙인 transport)는 조용한 빈 스트림 대신 loud-fail 한다.
  const deafTransport = {
    invoke() {
      return Promise.resolve(null);
    },
  };
  assert.throws(
    () => subscribeEvent(deafTransport as never, 'tick', () => {}),
    (error: unknown) => error instanceof Error && /drainEvents|push/i.test(String(error)),
  );
});

test('transport without push capability moves to polling after the handshake verdict', async () => {
  // 실 NodeLoopTransport 는 onPushEvent 를 항상 노출하지만, 능력(pushCapable)
  // 은 핸드셰이크 정착 후 확정된다. 미수용(codecs 미제공/구 런타임)이 확정되면
  // 푸시 경로가 폴링으로 1회 이동한다 — 죽은 푸시 스트림에 조용히 갇히지 않게.
  const restore = useFastPolling();
  try {
    let drains = 0;
    let pushed = 0;
    let accepted = false;
    const listeners = new Set<(event: { name: string; payload: string }) => void>();
    const transport = {
      invoke() {
        return Promise.resolve(null);
      },
      drainEvents() {
        drains += 1;
        return Promise.resolve([{ name: 'tick', payload: 'from-poll' }]);
      },
      onPushEvent(handler: (event: { name: string; payload: string }) => void) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      ready() {
        // 핸드셰이크 응답이 events:"push" 를 에코하지 않은 시나리오.
        accepted = false;
        return Promise.resolve();
      },
      get pushCapable() {
        return accepted;
      },
      dispose() {},
      get pid() {
        return null;
      },
      get mode() {
        return 'binary' as const;
      },
      drain() {
        return Promise.resolve();
      },
      /** 테스트 관찰용 — 푸시 프레임 도착 시뮬레이션. */
      emit(name: string, payload: string) {
        for (const listener of [...listeners]) listener({ name, payload });
        pushed += 1;
      },
    };
    const got: unknown[] = [];
    subscribeEvent(transport as never, 'tick', (p) => got.push(p));
    // 확정 전 푸시 프레임은 전달된다(싱크는 핸드셰이크 응답 전 설치 — 유실 없음).
    transport.emit('tick', '{"early":true}');
    await waitFor(() => drains >= 1, 2000);
    assert.deepEqual(got, [{ early: true }, 'from-poll'], 'push first, then polling takes over');
    // 조기 푸시 프레임은 정확히 1회 도달 — 두 번째원소는 폴링 drain 이다.
    assert.equal(pushed, 1, 'exactly one early push frame reached the listener');
    assert.equal(listeners.size, 0, 'push listener detached after the polling verdict');
  } finally {
    restore();
  }
});
