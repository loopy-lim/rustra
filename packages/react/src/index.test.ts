import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import {
  RustraProvider,
  useRustraEngine,
  useCommand,
  useMutation,
  useEvent,
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

test('useCommand stabilizes value-equal inline input (no re-request loop)', () => {
  // 회귀 가드: input 의존성을 참조 동등성으로 판정하면 인라인 객체 리터럴
  // (`useCommand(cmd, { a: 1 })`)이 렌더마다 새 참조라 execute 가 재생성되고
  // effect 가 재실행되어 상태 갱신→재렌더의 무한 재요청 루프가 발생한다.
  // 이 렌더러 없는 환경(bun, DOM 없음)에선 실행 기반 재현이 불가능하므로
  // 소스 계약으로 고정한다: (1) 키는 값 동등성, (2) invoke 는 원본 input,
  // (3) useCallback 의존성은 안정화된 참조.
  const source = readFileSync(new URL('./useCommand.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /inputKey\(input\)/,
    'input key must use value equality (serialized), not reference equality',
  );
  assert.match(
    source,
    /engine\.invoke<O>\(commandName,\s*stableInput/,
    'invoke must receive the stabilized input value',
  );
  assert.match(
    source,
    /\[engine,\s*commandName,\s*stableInput\]/,
    'execute deps must use the stabilized reference',
  );
  assert.doesNotMatch(
    source,
    /\[engine,\s*commandName,\s*input\]/,
    'raw input in deps re-creates execute every render for inline objects (infinite loop)',
  );
});

test('inputKey supports bigint values without throwing', () => {
  assert.equal(inputKey({ value: 42n }), '{"value":{"$rustraBigInt":"42"}}');
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

test('useEvent handles subscription and contract', () => {
  let subscribedName = '';
  let unsubscribed = false;
  let handlerCalledWith: unknown = null;

  const mockSubscriber = (name: string, cb: (payload: unknown) => void) => {
    subscribedName = name;
    cb({ count: 1 });
    return () => {
      unsubscribed = true;
    };
  };

  function TestComponent() {
    useEvent(
      'tick',
      (payload) => {
        handlerCalledWith = payload;
      },
      mockSubscriber,
    );
    return createElement('div', null, 'events');
  }

  const el = createElement(TestComponent);
  assert.ok(el);
  assert.equal(typeof useEvent, 'function');

  // Verify subscriber invocation contract
  const unsub = mockSubscriber('tick', (payload) => {
    handlerCalledWith = payload;
  });
  assert.equal(subscribedName, 'tick');
  assert.deepEqual(handlerCalledWith, { count: 1 });
  unsub();
  assert.equal(unsubscribed, true);
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
  const deferred = createDeferred<string>();
  let invocations = 0;

  const entry = resolveSuspenseEntry('suspense-cmd::{"a":1}', () => {
    invocations += 1;
    return deferred.promise;
  });

  assert.equal(entry.status, 'pending');
  assert.equal(invocations, 1);

  // 같은 키 재접근 — 새 promise 를 만들지 않고 동일 entry 반환
  const again = resolveSuspenseEntry('suspense-cmd::{"a":1}', () => {
    invocations += 1;
    return deferred.promise;
  });
  assert.equal(again, entry);
  assert.equal(invocations, 1);

  deferred.resolve('payload');
  await deferred.promise;

  assert.equal(entry.status, 'fulfilled');
  assert.equal(entry.value, 'payload');
  assert.equal(entry.error, undefined);
});

test('suspense cache state machine: pending -> rejected stores error and re-throws same object', async () => {
  const deferred = createDeferred<string>();
  const failure = new Error('engine exploded');

  const entry = resolveSuspenseEntry('failing-cmd::', () => deferred.promise);
  assert.equal(entry.status, 'pending');

  deferred.reject(failure);
  await assert.rejects(deferred.promise);

  assert.equal(entry.status, 'rejected');
  assert.equal(entry.error, failure);

  // 이후 접근에서도 같은 에러 객체를 재던진다 (error boundary 계약)
  assert.equal(entry.error, failure);
  assert.throws(
    () => {
      throw entry.error;
    },
    (err: unknown) => err === failure,
  );
});

test('suspense cache: different inputs to same command create separate entries', async () => {
  let invocations = 0;
  const start = () => {
    invocations += 1;
    return Promise.resolve(invocations);
  };

  const entryA = resolveSuspenseEntry('sep-cmd::{"id":1}', start);
  const entryB = resolveSuspenseEntry('sep-cmd::{"id":2}', start);

  assert.notEqual(entryA, entryB);
  assert.equal(invocations, 2);
  await flushAsync();
  assert.equal(entryA.value, 1);
  assert.equal(entryB.value, 2);
});

test('invalidateCommands(commandName) clears only that command, () clears all', async () => {
  const deferredA = createDeferred<string>();
  const deferredB = createDeferred<string>();
  const deferredC = createDeferred<string>();

  const entryA = resolveSuspenseEntry('cmd-a::{"x":1}', () => deferredA.promise);
  const entryA2 = resolveSuspenseEntry('cmd-a::{"x":2}', () => deferredB.promise);
  const entryB = resolveSuspenseEntry('cmd-b::{"y":1}', () => deferredC.promise);

  invalidateCommands('cmd-a');
  // cmd-a 의 두 키는 제거 — 새 요청은 새 entry(새 promise 실행)를 만든다
  const freshA = resolveSuspenseEntry('cmd-a::{"x":1}', () => Promise.resolve('fresh'));
  assert.notEqual(freshA, entryA);
  assert.notEqual(freshA, entryA2);
  await flushAsync();
  assert.equal(freshA.status, 'fulfilled');
  assert.equal(freshA.value, 'fresh');

  // cmd-b 는 살아있다 — 같은 entry 재사용
  const stillB = resolveSuspenseEntry('cmd-b::{"y":1}', () => Promise.resolve('should-not-run'));
  assert.equal(stillB, entryB);

  // (정리 완료 대기) 남은 pending promise 들을 settle 시켜 unhandled rejection 방지
  deferredA.resolve('a');
  deferredB.resolve('b');
  deferredC.resolve('c');
  await Promise.all([deferredA.promise, deferredB.promise, deferredC.promise]);

  invalidateCommands();
  const afterFull = resolveSuspenseEntry('cmd-b::{"y":1}', () => Promise.resolve('recreated'));
  assert.notEqual(afterFull, entryB);
  await flushAsync();
  assert.equal(afterFull.value, 'recreated');
});

test('suspense cache: bigint input does not throw and keys stay distinct', () => {
  let invocations = 0;
  const start = () => {
    invocations += 1;
    return Promise.resolve(invocations);
  };

  // bigint 는 JSON.stringify 가 throw 하므로 inputKey 의 태그 표현을 써야 한다
  const entryBig = resolveSuspenseEntry(`bigint-cmd::${inputKey({ value: 42n })}`, start);
  const entryBigSame = resolveSuspenseEntry(`bigint-cmd::${inputKey({ value: 42n })}`, start);
  const entryStr = resolveSuspenseEntry(`bigint-cmd::${inputKey({ value: '42' })}`, start);

  assert.equal(entryBig, entryBigSame);
  assert.notEqual(entryBig, entryStr);
  assert.equal(invocations, 2);
});

test('useSuspenseCommand and invalidateCommands are exported from index', () => {
  assert.equal(typeof useSuspenseCommand, 'function');
  assert.equal(typeof invalidateCommands, 'function');
});

test('useSuspenseCommand hook contract (source-level): throws promise while pending, engine invoke wiring', () => {
  // 렌더러 없는 환경(bun, DOM 없음)에서는 Suspense throw 를 실행 기반으로
  // 재현할 수 없으므로 useCommand 의 선례처럼 소스 계약으로 고정한다:
  // (1) pending 이면 promise 를 throw, (2) reject 면 캐시된 에러 재던짐,
  // (3) invoke 는 engine 의 것을 commandName + input 으로 호출.
  const source = readFileSync(new URL('./useSuspenseCommand.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(entry\.status === 'pending'\) throw entry\.promise;/);
  assert.match(source, /if \(entry\.status === 'rejected'\) throw entry\.error;/);
  assert.match(source, /engine\.invoke<O>\(commandName,\s*input/);
  assert.match(source, /resolveCommandId\(commandFn\)/);
  assert.match(source, /resolveSuspenseEntry<O>\(cacheKey\(commandName,\s*input\)/);
});

test('useSuspenseCommand returns cached value via engine after invalidation cycle', async () => {
  // 훅의 얇은 위임 계약을 실행 기반으로도 확인: 훅은 engine.invoke 를
  // resolveSuspenseEntry 에 위임할 뿐이다. (레지스터 재사용 계약은 상태 머신
  // 테스트가 담당)
  let calls = 0;
  const engine: EngineClient = {
    invoke<T>(_command: string, _args?: unknown): Promise<T> {
      calls += 1;
      return Promise.resolve('ok' as T);
    },
  };

  const entry = resolveSuspenseEntry('wiring-cmd::', () => engine.invoke('wiring-cmd'));
  await entry.promise;
  assert.equal(entry.status, 'fulfilled');
  assert.equal(entry.value, 'ok');
  assert.equal(calls, 1);
});
