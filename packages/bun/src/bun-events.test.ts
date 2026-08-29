import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { createBunEventBridge, type BunEventDrainSource } from './bun-events.js';

/**
 * FFI 없이 검증 가능한 주입형 테스트 — drain 소스를 폴링하는 브릿지 경로.
 * (실제 FFI 푸시 경로는 통합 스모크에서 실 dylib으로 검증)
 */
test('poll drain source dispatches to named subscribers', async () => {
  const batches: Array<Array<{ name: string; payload: unknown }>> = [
    [{ name: 'progress.tick', payload: { step: 1 } }],
    [{ name: 'demo.done', payload: { emitted: 3 } }],
    [],
  ];
  const drains: number[] = [];
  const source: BunEventDrainSource = {
    drainEvents() {
      drains.push(drains.length);
      return Promise.resolve(batches[drains.length - 1] ?? []);
    },
  };
  const bridge = await createBunEventBridge({ poll: source });
  const ticks: unknown[] = [];
  const dones: unknown[] = [];
  const unTick = bridge.subscribeEvent('progress.tick', (p) => ticks.push(p));
  bridge.subscribeEvent('demo.done', (p) => dones.push(p));
  await waitFor(() => ticks.length >= 1 && dones.length >= 1);
  unTick();
  bridge.dispose();
  assert.deepEqual(ticks, [{ step: 1 }]);
  assert.deepEqual(dones, [{ emitted: 3 }]);
});

test('polling stops when the last subscriber unsubscribes', async () => {
  let drainCount = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drainCount += 1;
      return Promise.resolve([{ name: 'x', payload: null }]);
    },
  };
  const bridge = await createBunEventBridge({ poll: source });
  const unsubscribe = bridge.subscribeEvent('x', () => {});
  await waitFor(() => drainCount >= 1);
  unsubscribe();
  await Bun.sleep(15);
  const count = drainCount;
  await Bun.sleep(15);
  assert.equal(drainCount, count, 'polling halted after last unsubscribe');
  bridge.dispose();
});

test('multiple subscribers share one polling loop', async () => {
  let drainCount = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drainCount += 1;
      return Promise.resolve([{ name: 'tick', payload: drainCount }]);
    },
  };
  const bridge = await createBunEventBridge({ poll: source });
  const a: unknown[] = [];
  const b: unknown[] = [];
  const unA = bridge.subscribeEvent('tick', (p) => a.push(p));
  bridge.subscribeEvent('tick', (p) => b.push(p));
  await waitFor(() => a.length >= 2 && b.length >= 2);
  unA();
  bridge.dispose();
  assert.deepEqual(a, b);
});

test('unsubscribe is idempotent and safe after dispose', async () => {
  let drainCount = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drainCount += 1;
      return Promise.resolve([]);
    },
  };
  const bridge = await createBunEventBridge({ poll: source });
  const un = bridge.subscribeEvent('x', () => {});
  await waitFor(() => drainCount >= 1);
  un();
  un();
  bridge.dispose();
  bridge.dispose();
  un();
  expect(true).toBe(true);
});

// ── helpers ──────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error('waitFor timed out');
}
