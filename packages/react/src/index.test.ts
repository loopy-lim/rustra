import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  RustraProvider,
  useRustraEngine,
  useCommand,
  useMutation,
  useSuspenseCommand,
  invalidateCommands,
} from './index.js';
import type { EngineClient } from '@rustra/types';
import type { UseCommandResult } from './useCommand.js';
import type { UseMutationResult } from './useMutation.js';
import { inputKey } from './input-key.js';
import { resolveSuspenseEntry } from './useSuspenseCommand.js';

function createTestEngine(dataMap: Record<string, unknown>): EngineClient {
  return {
    async invoke<T>(command: string, _args?: unknown): Promise<T> {
      if (command in dataMap) {
        return dataMap[command] as T;
      }
      throw new Error(`Command not found: ${command}`);
    },
  };
}

test('RustraProvider supplies engine to useRustraEngine', () => {
  const engine = createTestEngine({ testCmd: 'hello' });
  let capturedEngine: EngineClient | null = null;

  function TestComponent() {
    capturedEngine = useRustraEngine();
    return createElement('div', null, 'test');
  }

  renderToString(createElement(RustraProvider, { engine }, createElement(TestComponent)));

  assert.equal(capturedEngine, engine);
});

test('useCommand hook contract and properties', () => {
  async function dummyCmd(input: { val: number }): Promise<{ res: number }> {
    return { res: input.val * 2 };
  }

  const hookResult: { current: UseCommandResult<{ res: number }> | null } = { current: null };

  function TestComponent() {
    const result = useCommand(dummyCmd, { val: 5 }, { enabled: false });
    hookResult.current = result;
    return createElement('div', null, String(result.loading));
  }

  const engine = createTestEngine({ dummyCmd: { res: 10 } });
  renderToString(createElement(RustraProvider, { engine }, createElement(TestComponent)));

  const result = hookResult.current;
  assert.ok(result);
  assert.equal(result.loading, false);
  assert.equal(typeof result.refetch, 'function');
});

test('inputKey supports bigint values without throwing', () => {
  assert.equal(inputKey({ value: 42n }), inputKey({ value: 42n }));
  assert.notEqual(inputKey({ value: 42n }), inputKey({ value: { $rustraBigInt: '42' } }));
});

test('useMutation hook contract and execution', async () => {
  async function updateItem(_input: { id: string }): Promise<{ updated: boolean }> {
    return { updated: true };
  }

  const engine = createTestEngine({ updateItem: { updated: true } });
  const mutationResult: {
    current: UseMutationResult<{ id: string }, { updated: boolean }> | null;
  } = { current: null };

  function TestComponent() {
    mutationResult.current = useMutation(updateItem);
    return createElement('div', null, 'mutation');
  }

  renderToString(createElement(RustraProvider, { engine }, createElement(TestComponent)));

  const result = mutationResult.current;
  assert.ok(result);
  assert.equal(typeof result.mutate, 'function');
  assert.equal(typeof result.mutateAsync, 'function');
  assert.equal(typeof result.reset, 'function');

  // Execute mutation
  const res = await result.mutateAsync({ id: 'item-1' });
  assert.deepEqual(res, { updated: true });
});

// ---------------------------------------------------------------------------
// useSuspenseCommand — 캐시 상태 머신(React 없이 검증) + export 계약
// ---------------------------------------------------------------------------

/** Pending 상태를 제어할 수 있는 deferred 헬퍼 — settle 시점을 테스트가 결정한다. */
function createDeferred<O>(): {
  promise: Promise<O>;
  resolve: (value: O) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: O) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<O>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 상태 머신의 `.then` 정착 콜백이 도는 것을 보장하기 위해 macrotask 만큼 대기한다. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('suspense cache state machine: pending -> fulfilled stores value', async () => {
  invalidateCommands();
  const deferred = createDeferred<string>();
  let invocations = 0;

  const entry = resolveSuspenseEntry('suspense-cmd::{"a":1}', 'suspense-cmd', () => {
    invocations += 1;
    return deferred.promise;
  });

  assert.equal(entry.status, 'pending');
  assert.equal(invocations, 1);

  // 같은 키 재접근 — 새 promise 를 만들지 않고 동일 entry 반환
  const again = resolveSuspenseEntry('suspense-cmd::{"a":1}', 'suspense-cmd', () => {
    invocations += 1;
    return deferred.promise;
  });
  assert.equal(again, entry);
  assert.equal(invocations, 1);

  deferred.resolve('payload');
  await entry.promise;

  assert.equal(entry.status, 'fulfilled');
  assert.equal(entry.value, 'payload');
  assert.equal(entry.error, undefined);

  // fulfilled 재접근 — 새 entry/실행 없이 동일 entry 재사용
  const settled = resolveSuspenseEntry('suspense-cmd::{"a":1}', 'suspense-cmd', () => {
    invocations += 1;
    return Promise.resolve('should-not-run');
  });
  assert.equal(settled, entry);
  assert.equal(invocations, 1);
});

test('suspense cache state machine: pending -> rejected stores error and re-throws same object', async () => {
  invalidateCommands();
  const deferred = createDeferred<string>();
  const failure = new Error('engine exploded');

  const entry = resolveSuspenseEntry('failing-cmd::', 'failing-cmd', () => deferred.promise);
  assert.equal(entry.status, 'pending');

  deferred.reject(failure);
  await assert.rejects(entry.promise);

  assert.equal(entry.status, 'rejected');
  // 같은 에러 객체가 저장·재사용된다 (error boundary 계약)
  assert.equal(entry.error, failure);
});

test('suspense cache: non-Error rejections are normalized to Error', async () => {
  invalidateCommands();
  const deferred = createDeferred<string>();
  // useCommand/useMutation 과의 관례 정합: non-Error reject 는 Error 로 감싼다
  const entry = resolveSuspenseEntry(
    'string-reject-cmd::',
    'string-reject-cmd',
    () => deferred.promise,
  );

  deferred.reject('plain string failure');
  await assert.rejects(entry.promise);

  assert.equal(entry.status, 'rejected');
  assert.ok(entry.error instanceof Error);
  assert.equal((entry.error as Error).message, 'plain string failure');
});

test('suspense cache: different inputs to same command create separate entries', async () => {
  invalidateCommands();
  let invocations = 0;
  const start = () => {
    invocations += 1;
    return Promise.resolve(invocations);
  };

  const entryA = resolveSuspenseEntry('sep-cmd::{"id":1}', 'sep-cmd', start);
  const entryB = resolveSuspenseEntry('sep-cmd::{"id":2}', 'sep-cmd', start);

  assert.notEqual(entryA, entryB);
  assert.equal(invocations, 2);
  await flushAsync();
  assert.equal(entryA.value, 1);
  assert.equal(entryB.value, 2);
});

test('invalidateCommands(commandName) clears only that command, () clears all', async () => {
  invalidateCommands();
  const deferredA = createDeferred<string>();
  const deferredB = createDeferred<string>();
  const deferredC = createDeferred<string>();

  const entryA = resolveSuspenseEntry('cmd-a::{"x":1}', 'cmd-a', () => deferredA.promise);
  const entryA2 = resolveSuspenseEntry('cmd-a::{"x":2}', 'cmd-a', () => deferredB.promise);
  const entryB = resolveSuspenseEntry('cmd-b::{"y":1}', 'cmd-b', () => deferredC.promise);

  invalidateCommands('cmd-a');
  // cmd-a 의 두 키는 제거 — 새 요청은 새 entry(새 promise 실행)를 만든다
  const freshA = resolveSuspenseEntry('cmd-a::{"x":1}', 'cmd-a', () => Promise.resolve('fresh'));
  assert.notEqual(freshA, entryA);
  assert.notEqual(freshA, entryA2);
  await flushAsync();
  assert.equal(freshA.status, 'fulfilled');
  assert.equal(freshA.value, 'fresh');

  // cmd-b 는 살아있다 — 같은 entry 재사용
  const stillB = resolveSuspenseEntry('cmd-b::{"y":1}', 'cmd-b', () =>
    Promise.resolve('should-not-run'),
  );
  assert.equal(stillB, entryB);

  // (정리 완료 대기) 남은 pending promise 들을 settle 시켜 unhandled rejection 방지
  deferredA.resolve('a');
  deferredB.resolve('b');
  deferredC.resolve('c');
  await Promise.all([deferredA.promise, deferredB.promise, deferredC.promise]);

  invalidateCommands();
  const afterFull = resolveSuspenseEntry('cmd-b::{"y":1}', 'cmd-b', () =>
    Promise.resolve('recreated'),
  );
  assert.notEqual(afterFull, entryB);
  await flushAsync();
  assert.equal(afterFull.value, 'recreated');
});

test('invalidateCommands matches the owning command exactly, not a key prefix', async () => {
  invalidateCommands();
  let invocations = 0;
  const start = () => {
    invocations += 1;
    return Promise.resolve(invocations);
  };

  // `#[command(name = "a::b")]` 처럼 이름에 :: 를 포함하는 커맨드 —
  // 'a' 로의 부분 무효화가 이를 지워선 안 된다 (prefix 매치 회귀 가드)
  const nested = resolveSuspenseEntry('a::b::{"k":1}', 'a::b', start);
  resolveSuspenseEntry('plain-cmd::{"k":1}', 'plain-cmd', start);
  assert.equal(invocations, 2);

  invalidateCommands('a');

  const stillNested = resolveSuspenseEntry('a::b::{"k":1}', 'a::b', start);
  assert.equal(stillNested, nested);
  // 등록 2회분만 실행 — 무효화 후 재접근에서 재실행되지 않았다
  assert.equal(invocations, 2);
});

test('suspense cache: bigint input does not throw and keys stay distinct', () => {
  invalidateCommands();
  let invocations = 0;
  const start = () => {
    invocations += 1;
    return Promise.resolve(invocations);
  };

  // bigint 는 JSON.stringify 가 throw 하므로 inputKey 의 태그 표현을 써야 한다
  const entryBig = resolveSuspenseEntry(
    `bigint-cmd::${inputKey({ value: 42n })}`,
    'bigint-cmd',
    start,
  );
  const entryBigSame = resolveSuspenseEntry(
    `bigint-cmd::${inputKey({ value: 42n })}`,
    'bigint-cmd',
    start,
  );
  const entryStr = resolveSuspenseEntry(
    `bigint-cmd::${inputKey({ value: '42' })}`,
    'bigint-cmd',
    start,
  );

  assert.equal(entryBig, entryBigSame);
  assert.notEqual(entryBig, entryStr);
  assert.equal(invocations, 2);
});

test('useSuspenseCommand and invalidateCommands are exported from index', () => {
  assert.equal(typeof useSuspenseCommand, 'function');
  assert.equal(typeof invalidateCommands, 'function');
});

test('resolveSuspenseEntry wires engine.invoke exactly once', async () => {
  invalidateCommands();
  // 훅의 얇은 위임 계약을 실행 기반으로 확인: 훅은 engine.invoke 를
  // resolveSuspenseEntry 에 위임할 뿐이며, settle 후 재접근은 재실행하지 않는다.
  let calls = 0;
  const engine: EngineClient = {
    invoke<T>(_command: string, _args?: unknown): Promise<T> {
      calls += 1;
      return Promise.resolve('ok' as T);
    },
  };

  const entry = resolveSuspenseEntry('wiring-cmd::', 'wiring-cmd', () =>
    engine.invoke('wiring-cmd'),
  );
  await entry.promise;
  assert.equal(entry.status, 'fulfilled');
  assert.equal(entry.value, 'ok');
  assert.equal(calls, 1);

  // 무효화 → 재요청 사이클: invalidate 후 같은 키 접근은 engine 을 다시 호출한다
  invalidateCommands('wiring-cmd');
  const fresh = resolveSuspenseEntry('wiring-cmd::', 'wiring-cmd', () =>
    engine.invoke('wiring-cmd'),
  );
  assert.notEqual(fresh, entry);
  await fresh.promise;
  assert.equal(calls, 2);
});
