import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, EngineClient, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, RustraError, UpdateItemInput, UpdateItemOutput } from './types.js';

export function createItem(engine: EngineClient, input: CreateItemInput): Promise<CreateItemOutput> {
  return engine.invoke<CreateItemOutput>('createItem', input);
}

export function deleteItem(engine: EngineClient, input: DeleteItemInput): Promise<DeleteItemOutput> {
  return engine.invoke<DeleteItemOutput>('deleteItem', input);
}

export function getItem(engine: EngineClient, input: GetItemInput): Promise<GetItemOutput> {
  return engine.invoke<GetItemOutput>('getItem', input);
}

export function listItems(engine: EngineClient, input: ListItemsInput): Promise<ListItemsOutput> {
  return engine.invoke<ListItemsOutput>('listItems', input);
}

export function updateItem(engine: EngineClient, input: UpdateItemInput): Promise<UpdateItemOutput> {
  return engine.invoke<UpdateItemOutput>('updateItem', input);
}

