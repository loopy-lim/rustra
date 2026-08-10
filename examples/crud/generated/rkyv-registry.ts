import { createItemCodec, deleteItemCodec, getItemCodec, listItemsCodec, updateItemCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  ['createItem', createItemCodec],
  ['deleteItem', deleteItemCodec],
  ['getItem', getItemCodec],
  ['listItems', listItemsCodec],
  ['updateItem', updateItemCodec],
]);
