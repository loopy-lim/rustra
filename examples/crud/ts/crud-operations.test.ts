import assert from 'node:assert/strict';
import test from 'node:test';
import { createItem, deleteItem, getItem, listItems, updateItem } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

function mockEngine(responses: Map<string, unknown>): EngineClient {
  const calls: Array<{ command: string; args: unknown }> = [];
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      const response = responses.get(command);
      if (response === undefined) throw new Error(`unexpected command: ${command}`);
      return response as T;
    },
  };
}

test('createItem sends correct command and returns item', async () => {
  const responses = new Map([['createItem', { item: { id: 'abc', name: 'Widget', value: 42 } }]]);
  const engine = mockEngine(responses);
  const result = await createItem(engine, { name: 'Widget', value: 42 });
  assert.deepEqual(result.item.name, 'Widget');
  assert.equal(result.item.value, 42);
});

test('getItem retrieves item by id', async () => {
  const responses = new Map([['getItem', { item: { id: 'abc', name: 'Widget', value: 42 } }]]);
  const engine = mockEngine(responses);
  const result = await getItem(engine, { id: 'abc' });
  assert.deepEqual(result.item, { id: 'abc', name: 'Widget', value: 42 });
});

test('getItem returns null for missing item', async () => {
  const responses = new Map([['getItem', { item: null }]]);
  const engine = mockEngine(responses);
  const result = await getItem(engine, { id: 'missing' });
  assert.equal(result.item, null);
});

test('listItems returns filtered items', async () => {
  const responses = new Map([['listItems', { items: [{ id: '1', name: 'A', value: 10 }] }]]);
  const engine = mockEngine(responses);
  const result = await listItems(engine, { minValue: 5 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'A');
});

test('updateItem patches name and value', async () => {
  const responses = new Map([['updateItem', { item: { id: 'abc', name: 'Updated', value: 99 } }]]);
  const engine = mockEngine(responses);
  const result = await updateItem(engine, { id: 'abc', name: 'Updated', value: 99 });
  assert.equal(result.item!.name, 'Updated');
  assert.equal(result.item!.value, 99);
});

test('deleteItem returns deleted status', async () => {
  const responses = new Map([['deleteItem', { deleted: true }]]);
  const engine = mockEngine(responses);
  const result = await deleteItem(engine, { id: 'abc' });
  assert.equal(result.deleted, true);
});
