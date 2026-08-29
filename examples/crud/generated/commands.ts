import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { invokeGenerated, invokeGeneratedFields1 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invokeGenerated<CreateItemOutput>(1, 'createItem', input, options);
}
createItem.commandId = 'createItem';

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
