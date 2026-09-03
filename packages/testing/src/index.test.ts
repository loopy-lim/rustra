import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createMockEngine,
  assertContractCurrent,
  expectContractCurrent,
  assertContractFieldsCurrent,
  expectContractFieldsCurrent,
  assertContractHashCurrent,
} from './index.js';
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
  assert.equal(engine.calls().length, 1, 'pre-aborted calls must not reach the mock handler log');

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

test('mock engine supports deterministic delay, injected errors, and events', async () => {
  const engine = createMockEngine({ delayMs: 1 });
  const received: unknown[] = [];
  const unsubscribe = engine.subscribeEvent('progress', (payload) => received.push(payload));
  engine
    .on('slow', () => ({ ok: true }))
    .fail('broken', {
      code: 'transport.timeout',
      message: 'simulated timeout',
      retryable: true,
    });
  engine.emit('progress', { step: 1 });
  assert.deepEqual(received, [{ step: 1 }]);
  assert.deepEqual(engine.events(), [{ name: 'progress', payload: { step: 1 } }]);
  assert.deepEqual(await engine.invoke('slow'), { ok: true });
  await assert.rejects(
    () => engine.invoke('broken'),
    (error: unknown) =>
      error instanceof RustraCommandError &&
      error.code === 'transport.timeout' &&
      error.retryable === true,
  );
  unsubscribe();
  engine.emit('progress', { step: 2 });
  assert.deepEqual(received, [{ step: 1 }]);
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

// ── assertContractFieldsCurrent — 생성 commands.ts 필드 키 ↔ schema.json 대조 ──

/** 실제 코드젠 렌더러와 같은 형태의 commands.ts 조각을 만든다. */
function genFields2(commandId: number, name: string, fields: string[], fnName = name): string {
  return (
    `export const ${fnName} = createGeneratedFields2<${name[0].toUpperCase()}${name.slice(1)}Input, ` +
    `${name[0].toUpperCase()}${name.slice(1)}Output>(${commandId}, '${name}', ` +
    `${fields.map((f) => JSON.stringify(f)).join(', ')}, '${fnName}');`
  );
}

test('assertContractFieldsCurrent passes when fields match in wire order', () => {
  // 와이어 순서의 원천은 properties 키 순서(required 아님 — emitDemo 실측:
  // required ["stepDelayMs","ticks"] vs 생성 "ticks","stepDelayMs").
  const schema = {
    commands: [
      {
        name: 'emitDemo',
        inputSchema: {
          required: ['stepDelayMs', 'ticks'],
          properties: { ticks: { type: 'integer' }, stepDelayMs: { type: 'integer' } },
        },
      },
    ],
  };
  const source = genFields2(11, 'emitDemo', ['ticks', 'stepDelayMs']);
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, []);
});

test('assertContractFieldsCurrent detects field dropped from generated client', () => {
  const schema = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: {
          required: ['a', 'b'],
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        },
      },
    ],
  };
  const source = genFields2(1, 'addNumbers', ['a']);
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, [
    {
      command: 'addNumbers',
      kind: 'field_missing_in_client',
      detail: 'field "b" present in schema but missing from generated fields',
    },
  ]);
});

test('assertContractFieldsCurrent detects field order mismatch', () => {
  const schema = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: {
          required: ['a', 'b'],
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        },
      },
    ],
  };
  const source = genFields2(1, 'addNumbers', ['b', 'a']);
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, [
    {
      command: 'addNumbers',
      kind: 'field_order_mismatch',
      detail: 'field order differs: generated [b, a] vs schema [a, b]',
    },
  ]);
});

test('assertContractFieldsCurrent detects schema-only field', () => {
  const schema = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: {
          required: ['a', 'b', 'c'],
          properties: {
            a: { type: 'integer' },
            b: { type: 'integer' },
            c: { type: 'integer' },
          },
        },
      },
    ],
  };
  // 생성은 2필드 헬퍼(createGeneratedFields2)로 드랍된 채.
  const source = genFields2(1, 'addNumbers', ['a', 'b']);
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, [
    {
      command: 'addNumbers',
      kind: 'field_missing_in_client',
      detail: 'field "c" present in schema but missing from generated fields',
    },
  ]);
  // 역방향: 생성에만 있는 필드는 field_missing_in_schema.
  const narrow = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: {
          required: ['a'],
          properties: { a: { type: 'integer' } },
        },
      },
    ],
  };
  assert.deepEqual(
    assertContractFieldsCurrent(narrow, genFields2(1, 'addNumbers', ['a', 'b'])).drift,
    [
      {
        command: 'addNumbers',
        kind: 'field_missing_in_schema',
        detail: 'field "b" present in generated fields but missing from schema properties',
      },
    ],
  );
});

test('assertContractFieldsCurrent falls back to required when properties absent', () => {
  const schema = {
    commands: [
      { name: 'greet', inputSchema: { required: ['name'] } },
      {
        name: 'isEven',
        inputSchema: { required: ['n'], properties: { n: { type: 'integer' } } },
      },
    ],
  };
  const source =
    [
      `export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {`,
      `  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);`,
      `}`,
      `greet.commandId = 'greet';`,
      genFields2(3, 'isEven', ['n']),
    ].join('\n') + '\n';
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, []);
});

test('assertContractFieldsCurrent reports command missing from generated source', () => {
  const schema = {
    commands: [
      {
        name: 'staleCmd',
        inputSchema: { required: ['x'], properties: { x: { type: 'integer' } } },
      },
    ],
  };
  const source = genFields2(1, 'otherCmd', ['y']);
  assert.deepEqual(assertContractFieldsCurrent(schema, source).drift, [
    {
      command: 'staleCmd',
      kind: 'field_missing_in_client',
      detail: 'command entry not found in generated source',
    },
  ]);
});

test('assertContractFieldsCurrent reports unparseable source instead of silent pass', () => {
  const schema = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: { required: ['a', 'b'], properties: {} },
      },
    ],
  };
  // 매칭 0건 소스 — 조용한 통과가 아니라 unparseable_source 드리프트여야 한다.
  for (const empty of ['', 'export const x = 1;']) {
    const { drift } = assertContractFieldsCurrent(schema, empty);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].command, 'addNumbers');
    assert.equal(drift[0].kind, 'unparseable_source');
  }
});

test('expectContractFieldsCurrent throws with drift message and passes silently when clean', () => {
  const schema = {
    commands: [
      {
        name: 'addNumbers',
        inputSchema: { required: ['a', 'b'], properties: {} },
      },
    ],
  };
  assert.throws(
    () => expectContractFieldsCurrent(schema, 'export const x = 1;'),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : '';
      return (
        msg.includes('contract field drift detected') &&
        msg.includes('addNumbers') &&
        msg.includes('unparseable_source') &&
        msg.includes('regenerate')
      );
    },
  );
  expectContractFieldsCurrent(
    { commands: [{ name: 'greet', inputSchema: { properties: { name: { type: 'string' } } } }] },
    `invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);`,
  );
});

test('assertContractCurrent and expectContractCurrent keep prior behavior', () => {
  // 신규 함수 추가가 기존 게이트를 깨지 않았는지 회귀 확인.
  const ok = assertContractCurrent({ commands: [{ name: 'addNumbers' }] }, ['addNumbers']);
  assert.deepEqual(ok, { missingInClient: [], missingInSchema: [] });
  assert.deepEqual(assertContractCurrent({ commands: [{ name: 'a' }] }, ['a', 'ghost']), {
    missingInClient: [],
    missingInSchema: ['ghost'],
  });
  expectContractCurrent({ commands: [{ name: 'addNumbers' }] }, ['addNumbers']);
});
