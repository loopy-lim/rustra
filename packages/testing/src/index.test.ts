import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createMockEngine, assertContractCurrent, expectContractCurrent } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('mock engine invokes registered handler', async () => {
  const engine = createMockEngine();
  engine.on('addNumbers', (args: { a: number; b: number }) => args.a + args.b);
  const result = await engine.invoke<number>('addNumbers', { a: 20, b: 22 });
  assert.equal(result, 42);
});

test('type-safe mock method registers command by function reference', async () => {
  async function computeSum(input: { a: number; b: number }): Promise<{ sum: number }> {
    return { sum: input.a + input.b };
  }

  const engine = createMockEngine().mock(computeSum, ({ a, b }) => ({ sum: a + b }));
  const result = await engine.invoke<{ sum: number }>('computeSum', { a: 10, b: 25 });
  assert.deepEqual(result, { sum: 35 });
});

test('unknown command rejects with RustraCommandError command.not_found', async () => {
  const engine = createMockEngine();
  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'command.not_found',
  );
});

test('handler errors become RustraCommandError with custom code', async () => {
  const engine = createMockEngine();
  engine.on('fail', () => {
    throw { code: 'validation.too_large', message: 'value exceeds limit' };
  });
  await assert.rejects(
    () => engine.invoke('fail'),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'validation.too_large',
  );
});

test('on returns engine for chaining', () => {
  const engine = createMockEngine();
  const returned = engine.on('x', () => 1);
  assert.equal(returned, engine);
});

test('mock engine records calls for ordering assertions', async () => {
  const engine = createMockEngine();
  engine.on('a', () => 1).on('b', () => 2);
  await engine.invoke('a', { x: 1 });
  await engine.invoke('b');
  assert.deepEqual(engine.calls(), [
    { command: 'a', args: { x: 1 }, options: undefined },
    { command: 'b', args: undefined, options: undefined },
  ]);
});

test('mock engine records options and rejects pre-aborted signals', async () => {
  const engine = createMockEngine();
  engine.on('a', () => 1);
  const ac = new AbortController();
  await engine.invoke('a', undefined, { signal: ac.signal, timeoutMs: 100 });
  // signal/timeoutMs 가 기록된다 — "signal 로 호출했는지" 검증 가능.
  const last = engine.calls().at(-1);
  assert.equal(last?.options?.timeoutMs, 100);
  assert.equal(last?.options?.signal, ac.signal);

  // pre-aborted — 전 어댑터 공통 정책(cancelled, retryable).
  ac.abort();
  await assert.rejects(
    () => engine.invoke('a', undefined, { signal: ac.signal }),
    (err: unknown) =>
      err instanceof RustraCommandError && err.code === 'cancelled' && err.retryable === true,
  );

  // reset 이 기록을 비운다.
  engine.reset();
  assert.deepEqual(engine.calls(), []);
});

test('mock engine supports invokeBatch routing per entry', async () => {
  const engine = createMockEngine();
  engine.on('a', () => 1).on('b', () => 2);
  const batch = engine.invokeBatch!;
  const results = await batch([{ command: 'a', args: { x: 1 } }, { command: 'b' }]);
  assert.deepEqual(results, [1, 2]);
  assert.equal(engine.calls().length, 2);
});

test('assertContractCurrent passes when commands match', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../fixtures/schema.sample.json', import.meta.url), 'utf-8'),
  ) as { commands: Array<{ name: string }> };
  const ok = assertContractCurrent(schema, ['addNumbers', 'createItem']);
  assert.deepEqual(ok.missingInClient, []);
  assert.deepEqual(ok.missingInSchema, []);
});

test('assertContractCurrent detects drift both ways', () => {
  const schema = { commands: [{ name: 'addNumbers' }] };
  const result = assertContractCurrent(schema, ['addNumbers', 'staleCommand']);
  assert.deepEqual(result.missingInSchema, ['staleCommand']);
  assert.deepEqual(result.missingInClient, []);
});

test('expectContractCurrent throws with human-readable drift message', () => {
  const schema = { commands: [{ name: 'addNumbers' }, { name: 'extra' }] };
  // 드리프트: extra 는 클라이언트에 없고, ghost 는 스키마에 없다.
  assert.throws(
    () => expectContractCurrent(schema, ['addNumbers', 'ghost']),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : '';
      return msg.includes('extra') && msg.includes('ghost') && msg.includes('drift');
    },
  );
  // 정합이면 조용히 통과.
  expectContractCurrent({ commands: [{ name: 'addNumbers' }] }, ['addNumbers']);
});
