import assert from 'node:assert/strict';
import test from 'node:test';
import { configure } from '@rustra/types';
import { createItem, deleteItem, getItem, listItems, updateItem } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

function mockEngine(responses: Map<string, unknown>): EngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const response = responses.get(command);
      if (response === undefined) throw new Error(`unexpected command: ${command}`);
      return response as T;
    },
  };
}

test('createItem sends correct command and returns item', async () => {
  const responses = new Map([['createItem', { item: { id: 'abc', name: 'Widget', value: 42 } }]]);
  configure(mockEngine(responses));
  const result = await createItem({ name: 'Widget', value: 42 });
  assert.deepEqual(result.item.name, 'Widget');
  assert.equal(result.item.value, 42);
});

test('getItem retrieves item by id', async () => {
  const responses = new Map([['getItem', { item: { id: 'abc', name: 'Widget', value: 42 } }]]);
  configure(mockEngine(responses));
  const result = await getItem({ id: 'abc' });
  assert.deepEqual(result.item, { id: 'abc', name: 'Widget', value: 42 });
});

test('getItem returns null for missing item', async () => {
  const responses = new Map([['getItem', { item: null }]]);
  configure(mockEngine(responses));
  const result = await getItem({ id: 'missing' });
  assert.equal(result.item, null);
});

test('listItems returns filtered items', async () => {
  const responses = new Map([['listItems', { items: [{ id: '1', name: 'A', value: 10 }] }]]);
  configure(mockEngine(responses));
  const result = await listItems({ minValue: 5 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'A');
});

test('updateItem patches name and value', async () => {
  const responses = new Map([['updateItem', { item: { id: 'abc', name: 'Updated', value: 99 } }]]);
  configure(mockEngine(responses));
  const result = await updateItem({ id: 'abc', name: 'Updated', value: 99 });
  assert.equal(result.item!.name, 'Updated');
  assert.equal(result.item!.value, 99);
});

test('deleteItem returns deleted status', async () => {
  const responses = new Map([['deleteItem', { deleted: true }]]);
  configure(mockEngine(responses));
  const result = await deleteItem({ id: 'abc' });
  assert.equal(result.deleted, true);
});
