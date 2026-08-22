import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input, options);
}
createItem.commandId = 'createItem';

export function deleteItem(input: DeleteItemInput, options?: InvokeOptions): Promise<DeleteItemOutput> {
  return invoke<DeleteItemOutput>('deleteItem', input, options);
}
deleteItem.commandId = 'deleteItem';

export function getItem(input: GetItemInput, options?: InvokeOptions): Promise<GetItemOutput> {
  return invoke<GetItemOutput>('getItem', input, options);
}
getItem.commandId = 'getItem';

export function listItems(input: ListItemsInput, options?: InvokeOptions): Promise<ListItemsOutput> {
  return invoke<ListItemsOutput>('listItems', input, options);
}
listItems.commandId = 'listItems';

export function updateItem(input: UpdateItemInput, options?: InvokeOptions): Promise<UpdateItemOutput> {
  return invoke<UpdateItemOutput>('updateItem', input, options);
}
updateItem.commandId = 'updateItem';

