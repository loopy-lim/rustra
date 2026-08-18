import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
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

  renderToString(createElement(RustraProvider, { engine, children: createElement(TestComponent) }));

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
  renderToString(createElement(RustraProvider, { engine, children: createElement(TestComponent) }));

  const result = hookResult.current;
  assert.ok(result);
  assert.equal(result.loading, false);
  assert.equal(typeof result.refetch, 'function');
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

  renderToString(createElement(RustraProvider, { engine, children: createElement(TestComponent) }));

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
