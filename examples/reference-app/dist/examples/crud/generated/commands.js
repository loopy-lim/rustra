// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────
import { createGeneratedFields2, invokeGenerated, invokeGeneratedFields1 } from '@rustra/types';
export const createItem = createGeneratedFields2(1, 'createItem', "name", "value", 'createItem');
export function deleteItem(input, options) {
    return invokeGeneratedFields1(5, 'deleteItem', input, input["id"], options);
}
deleteItem.commandId = 'deleteItem';
export function getItem(input, options) {
    return invokeGeneratedFields1(2, 'getItem', input, input["id"], options);
}
getItem.commandId = 'getItem';
export function listItems(input, options) {
    return invokeGenerated(3, 'listItems', input, options);
}
listItems.commandId = 'listItems';
export function updateItem(input, options) {
    return invokeGenerated(4, 'updateItem', input, options);
}
updateItem.commandId = 'updateItem';
