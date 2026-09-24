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

test('failure logs capture frame forensics when the error carries frameBytes (M8)', async () => {
  // tier2 디코드 실패 정규화(@rustra/types M3) 는 RustraCommandError.frameBytes 에
  // 응답 프레임 복사본을 싣는다 — 계측기는 이를 hex 절단(앞 256B)과 전체 길이로
  // 실패 로그에 남긴다. 프로세스가 끝난 뒤 와이어를 재해석할 수 있는 유일한 흔적이다.
  const frame = new Uint8Array(300);
  frame[0] = 0xde;
  frame[1] = 0xad;
  frame[255] = 0xff;
  frame[256] = 0x01; // 256B 창 밖 — hex 에 나오면 안 된다
  const inner = {
    async invoke<T>(command: string): Promise<T> {
      const error = new Error(`decode failed for '${command}' at offset 300`);
      (error as { frameBytes?: Uint8Array }).frameBytes = frame;
      throw error;
    },
  };
  const engine = createInstrumentedEngine(inner);
  await engine.invoke('addNumbers', { a: 1 }).catch(() => {});
  const log = engine.report().logs[0]!;
  assert.equal(log.ok, false);
  assert.equal(log.frameByteLength, 300);
  assert.equal(log.frameBytesHex?.length, 512); // 256B × 2 자리
  assert.ok(log.frameBytesHex?.startsWith('dead'));
  assert.ok(log.frameBytesHex?.endsWith('ff')); // 255번째 바이트가 창의 끝
});

test('frame forensics stay absent for successes and frame-less failures (M8)', async () => {
  const engine = createInstrumentedEngine(makeInner());
  await engine.invoke('addNumbers', { a: 1 });
  await engine.invoke('fail').catch(() => {});
  const [success, failure] = engine.report().logs;
  assert.equal(success!.ok, true);
  assert.equal(success!.frameBytesHex, undefined);
  assert.equal(success!.frameByteLength, undefined);
  assert.equal(failure!.ok, false);
  assert.equal(failure!.frameBytesHex, undefined);
  assert.equal(failure!.frameByteLength, undefined);
});

test('frame forensics on batch failures surface through onLog entries too (M8)', async () => {
  const seen: unknown[] = [];
  const frame = new Uint8Array([0x01, 0x02]);
  const inner = {
    async invoke<T>(): Promise<T> {
      throw new Error('unreachable');
    },
    async invokeBatch<T>(): Promise<T[]> {
      const error = new Error('batch decode failed');
      (error as { frameBytes?: Uint8Array }).frameBytes = frame;
      throw error;
    },
  };
  const engine = createInstrumentedEngine(inner, {
    onLog: (entry) => seen.push(entry),
  });
  const batch = engine.invokeBatch!;
  await batch([{ command: 'addNumbers' }]).catch(() => {});
  const log = seen[0] as { ok: boolean; frameBytesHex?: string; frameByteLength?: number };
  assert.equal(log.ok, false);
  assert.equal(log.frameBytesHex, '0102');
  assert.equal(log.frameByteLength, 2);
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
