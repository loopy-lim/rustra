// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedFields1 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(1, 'createItem', "name", "value", 'createItem');

export function deleteItem(input: DeleteItemInput, options?: InvokeOptions): Promise<DeleteItemOutput> {
  return invokeGeneratedFields1<DeleteItemOutput>(5, 'deleteItem', input, input["id"], options);
}
deleteItem.commandId = 'deleteItem';

export function getItem(input: GetItemInput, options?: InvokeOptions): Promise<GetItemOutput> {
  return invokeGeneratedFields1<GetItemOutput>(2, 'getItem', input, input["id"], options);
}
getItem.commandId = 'getItem';

export function listItems(input: ListItemsInput, options?: InvokeOptions): Promise<ListItemsOutput> {
  return invokeGenerated<ListItemsOutput>(3, 'listItems', input, options);
}
listItems.commandId = 'listItems';

export function updateItem(input: UpdateItemInput, options?: InvokeOptions): Promise<UpdateItemOutput> {
  return invokeGenerated<UpdateItemOutput>(4, 'updateItem', input, options);
}
updateItem.commandId = 'updateItem';
