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

test('invokeBatch is passed through when inner supports it', async () => {
  const inner = {
    ...makeInner(),
    async invokeBatch<T>(entries: Array<{ command: string; args?: unknown }>): Promise<T[]> {
      const results: T[] = [];
      for (const e of entries) {
        if (e.command === 'fail') throw new Error('batch boom');
        results.push({ echoed: e.args } as T);
      }
      return results;
    },
  };
  const engine = createInstrumentedEngine(inner);
  const batch = engine.invokeBatch!;
  const results = await batch<{ echoed: unknown }>([
    { command: 'addNumbers', args: { a: 1 } },
    { command: 'greet', args: { name: 'x' } },
  ]);
  assert.equal(results.length, 2);
  const report = engine.report();
  assert.equal(report.totalCalls, 2);
  assert.equal(report.commandStats.addNumbers.count, 1);
  assert.equal(report.commandStats.greet.count, 1);

  // 배치 실패 원인은 개별 엔트리로 추측하지 않고 batch-level에만 기록한다.
  await assert.rejects(() => batch([{ command: 'addNumbers' }, { command: 'fail' }]), /batch boom/);
  assert.equal(engine.report().batchStats.errors, 1);
  assert.equal(engine.report().batchStats.count, 2);
  assert.equal(engine.report().batchStats.entries, 4);
  assert.equal(engine.report().commandStats.fail.errors, 0);
  assert.equal(engine.report().commandStats.addNumbers.errors, 0);
});

test('invokeBatch is omitted when inner lacks it', () => {
  const engine = createInstrumentedEngine(makeInner());
  assert.equal(engine.invokeBatch, undefined);
});

test('invokeById is passed through without losing id, name, args, or options', async () => {
  const seen: unknown[] = [];
  const inner = {
    ...makeInner(),
    async invokeById<T>(
      commandId: number,
      command: string,
      args?: unknown,
      options?: unknown,
    ): Promise<T> {
      seen.push(commandId, command, args, options);
      return { value: 42 } as T;
    },
  };
  const engine = createInstrumentedEngine(inner);
  const options = { timeoutMs: 50 };
  const result = await engine.invokeById!<{ value: number }>(
    7,
    'addNumbers',
    { a: 20, b: 22 },
    options,
  );

  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(seen, [7, 'addNumbers', { a: 20, b: 22 }, options]);
  assert.equal(engine.report().commandStats.addNumbers.count, 1);
});

test('invokeById is omitted when inner lacks it', () => {
  const engine = createInstrumentedEngine(makeInner());
  assert.equal(engine.invokeById, undefined);
});

test('instrumented engine exposes bounded payload logs and a logging hook', async () => {
  const seen: string[] = [];
  const engine = createInstrumentedEngine(makeInner(), {
    capturePayload: true,
    maxLogEntries: 1,
    onLog: (entry) => seen.push(`${entry.command}:${entry.ok}`),
  });
  await engine.invoke('echo', { nested: { value: 42 } });
  await engine.invoke('echo', { later: true });
  const report = engine.report();
  assert.deepEqual(seen, ['echo:true', 'echo:true']);
  assert.equal(report.logs.length, 1);
  assert.deepEqual(report.logs[0]?.payload, { later: true });
  assert.deepEqual(report.logs[0]?.result, { echoed: { later: true } });
});
