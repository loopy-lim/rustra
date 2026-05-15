export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type RustraError = {
  readonly code: string;
  readonly message: string;
};

export type Item = {
  id: string;
  name: string;
  value: number;
};

export type CreateItemInput = {
  name: string;
  value: number;
};

export type CreateItemOutput = {
  item: Item;
};

export type DeleteItemInput = {
  id: string;
};

export type DeleteItemOutput = {
  deleted: boolean;
};

export type GetItemInput = {
  id: string;
};

export type GetItemOutput = {
  item?: Item | null;
};

export type ListItemsInput = {
  minValue?: number | null;
};

export type ListItemsOutput = {
  items: Item[];
};

export type UpdateItemInput = {
  id: string;
  name?: string | null;
  value?: number | null;
};

export type UpdateItemOutput = {
  item?: Item | null;
};
