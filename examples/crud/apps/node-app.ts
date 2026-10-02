/** Generated Node CRUD client: one opted-in persistent Rust runtime owns the store. */
import assert from 'node:assert/strict';
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  rustra,
  updateItem,
} from '../generated/node.js';

try {
  const { item } = await createItem({ name: 'retained across calls', value: 7 });
  assert.deepEqual((await getItem({ id: item.id })).item, item);
  const updated = await updateItem({ id: item.id, name: 'updated', value: 9 });
  assert.equal(updated.item?.value, 9);
  const other = await createItem({ name: 'below the filter', value: 0 });
  assert.equal((await listItems({ minValue: 8 })).items.length, 1);
  assert.equal((await deleteItem({ id: item.id })).deleted, true);
  assert.equal((await getItem({ id: item.id })).item, null);
  assert.equal((await deleteItem({ id: other.item.id })).deleted, true);
  console.log('[crud] PASS — generated create/read/update/list/delete share one Rust store');
} finally {
  rustra.dispose();
}
