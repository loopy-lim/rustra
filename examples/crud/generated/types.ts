// ── rustra generated ────────────────────────────────────────
// File:   types.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type Item = {
  id: string;
  name: string;
  value: number | bigint;
};

export type CreateItemInput = {
  name: string;
  value: number | bigint;
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
  minValue?: number | bigint | null;
};

export type ListItemsOutput = {
  items: Item[];
};

export type UpdateItemInput = {
  id: string;
  name?: string | null;
  value?: number | bigint | null;
};

export type UpdateItemOutput = {
  item?: Item | null;
};
