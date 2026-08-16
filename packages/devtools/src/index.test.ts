import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstrumentedEngine } from './index.js';

function makeInner() {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      if (command === 'fail') throw new Error('boom');
      return { echoed: args } as T;
    },
  };
}

test('instrumented engine records calls, durations, errors', async () => {
  const engine = createInstrumentedEngine(makeInner());
  await engine.invoke('addNumbers', { a: 1 });
  await engine.invoke('addNumbers', { a: 2 });
  await engine.invoke('fail').catch(() => {});
  const report = engine.report();
  assert.equal(report.totalCalls, 3);
  assert.equal(report.commandStats.addNumbers.count, 2);
  assert.equal(report.commandStats.addNumbers.errors, 0);
  assert.equal(report.commandStats.fail.errors, 1);
  assert.ok(report.commandStats.addNumbers.avgMs >= 0);
});

test('errors propagate unchanged after being recorded', async () => {
  const engine = createInstrumentedEngine(makeInner());
  await assert.rejects(() => engine.invoke('fail'), /boom/);
  assert.equal(engine.report().commandStats.fail.errors, 1);
});

test('slowest list is ordered desc and capped at 10', async () => {
  const engine = createInstrumentedEngine(makeInner());
  for (let i = 0; i < 12; i++) await engine.invoke('tick');
  const report = engine.report();
  assert.ok(report.slowest.length <= 10);
  for (let i = 1; i < report.slowest.length; i++) {
    assert.ok(report.slowest[i - 1].ms >= report.slowest[i].ms);
  }
});
