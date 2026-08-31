import assert from 'node:assert/strict';
import test from 'node:test';
import { createParityGate, type ParitySnapshot } from './parity-gate.js';

// ── parity gate (Task A2) ────────────────────────────────────────────────────
//
// dev.wasm.parityGate(기본 true)일 때 dev 루프가 reload 전후 계약 상태를
// 대조해 불일치 시 리로드를 거부한다. capture/verify는 호스트가 주입한다 —
// 게이트 코어는 순수 비교+거부 오케스트레이션이다(dev-tooling, 런타임 아님).

function snapshot(contractHash: string, golden: string): ParitySnapshot {
  return { contractHash, golden };
}

test('createParityGate passes when the post-reload state matches the snapshot', async () => {
  const gate = createParityGate({
    capture: async () => snapshot('h1', 'g1'),
  });
  await gate.arm();
  // 같은 상태를 반환하는 대조 — 리로드가 계약을 보존했음을 의미.
  const verdict = await gate.verify();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, undefined);
});

test('createParityGate rejects when the contract hash drifts after reload', async () => {
  const calls: string[] = [];
  const gate = createParityGate({
    capture: async () => {
      calls.push('capture');
      return snapshot(calls.length === 1 ? 'h1' : 'h2', 'g1');
    },
  });
  await gate.arm();
  const verdict = await gate.verify();
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /contract hash drift/i);
  assert.match(String(verdict.reason), /h1/, 'before hash in the message');
  assert.match(String(verdict.reason), /h2/, 'after hash in the message');
});

test('createParityGate rejects when the golden wire bytes drift after reload', async () => {
  let n = 0;
  const gate = createParityGate({
    capture: async () => {
      n += 1;
      return snapshot('h1', n === 1 ? 'aa' : 'bb');
    },
  });
  await gate.arm();
  const verdict = await gate.verify();
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /golden wire/i);
});

test('createParityGate verify rejects when capture throws after reload', async () => {
  let alive = true;
  const gate = createParityGate({
    capture: async () => {
      if (!alive) throw new Error('engine dead after reload');
      return snapshot('h1', 'g1');
    },
  });
  await gate.arm();
  alive = false;
  const verdict = await gate.verify();
  assert.equal(verdict.ok, false, 'capture failure must not pass the gate');
  assert.match(String(verdict.reason), /engine dead after reload/);
});

test('createParityGate arm failure reports an unusable baseline', async () => {
  const gate = createParityGate({
    capture: async () => {
      throw new Error('no engine before reload');
    },
  });
  await assert.rejects(() => gate.arm(), /no engine before reload/);
});

test('createParityGate disarm skips verification', async () => {
  let n = 0;
  const gate = createParityGate({
    capture: async () => {
      n += 1;
      return snapshot('h1', 'g1');
    },
  });
  await gate.arm();
  gate.disarm();
  const verdict = await gate.verify();
  assert.equal(verdict.ok, true, 'disarmed gate is a no-op (native dev path)');
  assert.equal(n, 1, 'disarmed gate must not capture again');
});

test('createParityGate rearms to the current state after every verdict', async () => {
  // 재무장 계약: 판정 후 기준이 현재 상태로 옮겨가지 않으면 합법적 스키마
  // 변경(또는 capture 실패 복구) 이후의 모든 리로드가 영원히 거부되는 쐐기가
  // 된다. 거부 직후의 다음 리로드는 반드시 통과해야 한다.
  let state = 'h1';
  const gate = createParityGate({
    capture: async () => snapshot(state, 'g1'),
  });
  await gate.arm();
  state = 'h2'; // 합법적 스키마 변경 — 첫 판정은 거부한다.
  const rejected = await gate.verify();
  assert.equal(rejected.ok, false);
  assert.match(String(rejected.reason), /contract hash drift/);
  const next = await gate.verify(); // 새 기준(h2) 대조 — 같은 상태라 통과.
  assert.equal(next.ok, true, 'rejection must not wedge subsequent reloads');
});
