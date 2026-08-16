import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createMockEngine, assertContractCurrent } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('mock engine invokes registered handler', async () => {
  const engine = createMockEngine();
  engine.on('addNumbers', (args: { a: number; b: number }) => args.a + args.b);
  const result = await engine.invoke<number>('addNumbers', { a: 20, b: 22 });
  assert.equal(result, 42);
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
    { command: 'a', args: { x: 1 } },
    { command: 'b', args: undefined },
  ]);
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
