import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { RustraProvider, useRustraEngine, useCommand, useMutation, useEvent } from './index.js';
import type { EngineClient } from '@rustra/types';
import type { UseCommandResult } from './useCommand.js';
import type { UseMutationResult } from './useMutation.js';

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
    /JSON\.stringify\(input\)/,
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
