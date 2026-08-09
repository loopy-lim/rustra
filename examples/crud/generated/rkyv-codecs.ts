// ── postcard wire format helpers ─────────────────────────────

function _pcEncodeVarint(n: number): Uint8Array {
  n = n >>> 0; // ensure unsigned 32-bit
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  while (n > 0) {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

function _pcDecodeVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (true) {
    const b = buf[offset + bytesRead];
    value |= (b & 0x7f) << shift;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (bytesRead > 5) throw new Error('varint too long');
  }
  return { value: value >>> 0, bytesRead };
}

function _pcEncodeZigzag(n: number): number {
  // zigzag encode: positive n -> n*2, negative n -> (-n)*2 - 1
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function _pcDecodeZigzag(n: number): number {
  // zigzag decode: (n >>> 1) ^ -(n & 1)
  return (n >>> 1) ^ -(n & 1);
}

function _pcEncodeZigzagVarint(n: number): Uint8Array {
  return _pcEncodeVarint(_pcEncodeZigzag(n));
}

function _pcDecodeZigzagVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  const { value, bytesRead } = _pcDecodeVarint(buf, offset);
  return { value: _pcDecodeZigzag(value), bytesRead };
}

function _pcConcatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function _pcEncodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return _pcConcatUint8Arrays([_pcEncodeVarint(bytes.length), bytes]);
}

function _pcDecodeString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len = _pcDecodeVarint(buf, offset);
  const strBytes = buf.slice(offset + len.bytesRead, offset + len.bytesRead + len.value);
  return {
    value: new TextDecoder().decode(strBytes),
    bytesRead: len.bytesRead + len.value,
  };
}

function _pcEncodeF64(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, true);
  return new Uint8Array(buf);
}

function _pcDecodeF64(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  return {
    value: new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true),
    bytesRead: 8,
  };
}

function _pcEncodeF32(n: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, n, true);
  return new Uint8Array(buf);
}

function _pcDecodeF32(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  return {
    value: new DataView(buf.buffer, buf.byteOffset + offset, 4).getFloat32(0, true),
    bytesRead: 4,
  };
}

import type { RkyvV2Codec } from '@rustra/types';
import type {
  CreateItemInput,
  CreateItemOutput,
  DeleteItemInput,
  DeleteItemOutput,
  GetItemInput,
  GetItemOutput,
  Item,
  ListItemsInput,
  ListItemsOutput,
  UpdateItemInput,
  UpdateItemOutput,
} from './types.js';

export const createItemCodec: RkyvV2Codec<CreateItemInput, CreateItemOutput> = {
  commandId: 1,

  encode(args: CreateItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(CreateItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 1, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.name));
    parts.push(_pcEncodeZigzagVarint(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: CreateItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      const err =
        errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    // Decode postcard from offset 8
    let offset = 8;
    const result: Partial<CreateItemOutput> = {};
    {
      const _obj: Item = {} as Item;
      {
        const _v = _pcDecodeString(u8, offset);
        _obj.id = _v.value;
        offset += _v.bytesRead;
      }
      {
        const _v = _pcDecodeString(u8, offset);
        _obj.name = _v.value;
        offset += _v.bytesRead;
      }
      {
        const _v = _pcDecodeZigzagVarint(u8, offset);
        _obj.value = _v.value;
        offset += _v.bytesRead;
      }
      result.item = _obj;
    }
    return { ok: true, result: result as CreateItemOutput };
  },
};

export const deleteItemCodec: RkyvV2Codec<DeleteItemInput, DeleteItemOutput> = {
  commandId: 5,

  encode(args: DeleteItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(DeleteItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 5, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.id));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: DeleteItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      const err =
        errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    // Decode postcard from offset 8
    let offset = 8;
    const result: Partial<DeleteItemOutput> = {};
    {
      result.deleted = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result: result as DeleteItemOutput };
  },
};

export const getItemCodec: RkyvV2Codec<GetItemInput, GetItemOutput> = {
  commandId: 2,

  encode(args: GetItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(GetItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 2, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.id));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: GetItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      const err =
        errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    return { ok: true, result: {} as GetItemOutput };
  },
};

export const listItemsCodec: RkyvV2Codec<ListItemsInput, ListItemsOutput> = {
  commandId: 3,

  encode(args: ListItemsInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ListItemsInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 3, true);
    parts.push(cmdId);
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ListItemsOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      const err =
        errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    return { ok: true, result: {} as ListItemsOutput };
  },
};

export const updateItemCodec: RkyvV2Codec<UpdateItemInput, UpdateItemOutput> = {
  commandId: 4,

  encode(args: UpdateItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(UpdateItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 4, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.id));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: UpdateItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      const err =
        errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    return { ok: true, result: {} as UpdateItemOutput };
  },
};
