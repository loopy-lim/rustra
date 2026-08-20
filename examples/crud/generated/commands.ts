import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { invoke } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export function createItem(input: CreateItemInput, options?: InvokeOptions): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input, options);
}

export function deleteItem(input: DeleteItemInput, options?: InvokeOptions): Promise<DeleteItemOutput> {
  return invoke<DeleteItemOutput>('deleteItem', input, options);
}

export function getItem(input: GetItemInput, options?: InvokeOptions): Promise<GetItemOutput> {
  return invoke<GetItemOutput>('getItem', input, options);
}

export function listItems(input: ListItemsInput, options?: InvokeOptions): Promise<ListItemsOutput> {
  return invoke<ListItemsOutput>('listItems', input, options);
}

export function updateItem(input: UpdateItemInput, options?: InvokeOptions): Promise<UpdateItemOutput> {
  return invoke<UpdateItemOutput>('updateItem', input, options);
}

