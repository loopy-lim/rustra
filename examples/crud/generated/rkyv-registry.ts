import { createItemCodec, deleteItemCodec, getItemCodec, listItemsCodec, updateItemCodec } from './rkyv-codecs.js';

export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([
  // route: postcard
  ['createItem', createItemCodec],
  // route: postcard
  ['deleteItem', deleteItemCodec],
  // route: postcard
  ['getItem', getItemCodec],
  // route: postcard
  ['listItems', listItemsCodec],
  // route: postcard
  ['updateItem', updateItemCodec],
]);
