import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createBunEventSubscription } from './bun-event-subscription.js';
import type { BunEventDrainSource } from './bun-events.js';

/**
 * 실 dylib 없이 검증 가능한 주입형 테스트 — 후보가 비어 poll 소스로 폴백하는 경로와
 * 후보/라이브러리가 전부 없을 때의 fail-fast 경로. 실제 FFI 푸시 경로는 통합 스모크에서
 * 실 dylib 으로 검증(bun-events.test.ts 와 동일 방침).
 */

test('subscription queues subscribers until the bridge is ready and dispatches in order', async () => {
  const batches: Array<Array<{ name: string; payload: unknown }>> = [
    [{ name: 'progress.tick', payload: { step: 1 } }],
    [],
  ];
  let drains = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      return Promise.resolve(batches[Math.min(drains++, batches.length - 1)]!);
    },
  };
  const subscription = createBunEventSubscription({ poll: source });
  const ticks: unknown[] = [];
  const dones: unknown[] = [];
  // 동기 시그니처 — SubscribeFn 계약(코드젠 onRustraEvent 에 그대로 전달 가능).
  const unTick = subscription.subscribeEvent('progress.tick', (p) => ticks.push(p));
  const unDone = subscription.subscribeEvent('demo.done', (p) => dones.push(p));
  await waitFor(() => ticks.length >= 1);
  unTick();
  unDone();
  subscription.dispose();
  assert.deepEqual(ticks, [{ step: 1 }]);
  assert.deepEqual(dones, []);
});

test('unsubscribe before the bridge is ready removes the queued subscriber', async () => {
  let drainCount = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drainCount += 1;
      return Promise.resolve([{ name: 'x', payload: drainCount }]);
    },
  };
  const subscription = createBunEventSubscription({ poll: source });
  const got: unknown[] = [];
  const unsubscribe = subscription.subscribeEvent('x', (p) => got.push(p));
  unsubscribe();
  await Bun.sleep(20);
  subscription.dispose();
  assert.deepEqual(got, [], 'queued subscriber was cancelled before delegation');
});

test('fail-fast: no candidates and no poll source throws on subscribe', () => {
  const subscription = createBunEventSubscription({ libraryCandidates: [] });
  assert.throws(
    () => subscription.subscribeEvent('x', () => {}),
    /No compatible Rustra Bun cdylib/,
  );
  // 실패는 고정 — 이후 호출도 같은 오류(프로세스 재시작이 회복 경로).
  assert.throws(
    () => subscription.subscribeEvent('y', () => {}),
    /No compatible Rustra Bun cdylib/,
  );
});

test('an empty candidate list falls back to the injected poll source', async () => {
  let drainCount = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drainCount += 1;
      return Promise.resolve([{ name: 'x', payload: null }]);
    },
  };
  const subscription = createBunEventSubscription({ libraryCandidates: [], poll: source });
  const got: unknown[] = [];
  subscription.subscribeEvent('x', (p) => got.push(p));
  await waitFor(() => drainCount >= 1);
  subscription.dispose();
  assert.deepEqual(got, [null]);
});

test('dispose before initialization cancels the pending bridge delegation', async () => {
  let drains = 0;
  const source: BunEventDrainSource = {
    drainEvents() {
      drains += 1;
      return Promise.resolve([]);
    },
  };
  const subscription = createBunEventSubscription({ poll: source });
  subscription.subscribeEvent('x', () => {});
  subscription.dispose();
  await Bun.sleep(20);
  // dispose 이후 초기화가 완료돼도 위임이 없으므로 폴링이 가동되지 않는다.
  assert.equal(drains, 0);
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
