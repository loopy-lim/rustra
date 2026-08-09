import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { invoke } from '@rustra/types';

export function createItem(input: CreateItemInput): Promise<CreateItemOutput> {
  return invoke<CreateItemOutput>('createItem', input);
}

export function deleteItem(input: DeleteItemInput): Promise<DeleteItemOutput> {
  return invoke<DeleteItemOutput>('deleteItem', input);
}

export function getItem(input: GetItemInput): Promise<GetItemOutput> {
  return invoke<GetItemOutput>('getItem', input);
}

export function listItems(input: ListItemsInput): Promise<ListItemsOutput> {
  return invoke<ListItemsOutput>('listItems', input);
}

export function updateItem(input: UpdateItemInput): Promise<UpdateItemOutput> {
  return invoke<UpdateItemOutput>('updateItem', input);
}

