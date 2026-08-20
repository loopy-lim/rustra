import { invoke } from '@rustra/types';
export function createItem(input, options) {
    return invoke('createItem', input, options);
}
export function deleteItem(input, options) {
    return invoke('deleteItem', input, options);
}
export function getItem(input, options) {
    return invoke('getItem', input, options);
}
export function listItems(input, options) {
    return invoke('listItems', input, options);
}
export function updateItem(input, options) {
    return invoke('updateItem', input, options);
}
