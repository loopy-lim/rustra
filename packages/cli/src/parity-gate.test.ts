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
  assert.match(String(rejected.reason), /h1/, 'before hash in the message');
  assert.match(String(rejected.reason), /h2/, 'after hash in the message');
  const next = await gate.verify(); // 새 기준(h2) 대조 — 같은 상태라 통과.
  assert.equal(next.ok, true, 'rejection must not wedge subsequent reloads');
});

test('createParityGate survives a transient capture failure without going silent', async () => {
  // fail-closed 재시도 계약: capture 실패가 기준을 파괴해 다음 판정이 무조건
  // 통과하는 fail-open(f68 이전 결함)이면, 일시적 capture 실패 이후의 실제
  // 드리프트가 조용히 통과한다. 기준은 유지되어야 하고, 복구된 첫 판정은
  // 유지된 기준과의 실제 대조여야 한다.
  let alive = true;
  let state = 'h1';
  const gate = createParityGate({
    capture: async () => {
      if (!alive) throw new Error('transient capture failure');
      return snapshot(state, 'g1');
    },
  });
  await gate.arm();
  alive = false;
  const failed = await gate.verify();
  assert.equal(failed.ok, false, 'capture failure must reject');
  assert.match(String(failed.reason), /transient capture failure/);

  alive = true;
  state = 'h2'; // capture 실패 기간에 벌어진 실제 드리프트.
  const drifted = await gate.verify();
  assert.equal(drifted.ok, false, 'drift after a transient failure must NOT pass silently');
  assert.match(String(drifted.reason), /contract hash drift/);

  const settled = await gate.verify(); // 기준은 h2 로 재무장 — 같은 상태는 통과.
  assert.equal(settled.ok, true, 'recovery must not wedge subsequent reloads');
});

test('createParityGate keeps rejecting while capture stays broken', async () => {
  // 지속 실패: 복구가 없는 한 모든 판정이 거부다 — 검증 불가능한 리로드는
  // 통과시키지 않는다(fail-closed). 기준 파괴로 인한 silent pass 가 없다.
  let calls = 0;
  const gate = createParityGate({
    capture: async () => {
      calls += 1;
      if (calls > 1) throw new Error('persistent capture failure');
      return snapshot('h1', 'g1');
    },
  });
  await gate.arm();
  const first = await gate.verify();
  assert.equal(first.ok, false);
  const second = await gate.verify();
  assert.equal(second.ok, false, 'persistent capture failure keeps rejecting');
  assert.match(String(second.reason), /persistent capture failure/);
});
