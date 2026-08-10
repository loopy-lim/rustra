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
  return n >= 0 ? n * 2 : (-n) * 2 - 1;
}

function _pcDecodeZigzag(n: number): number {
  // zigzag decode: (n >>> 1) ^ -(n & 1)
  return (n >>> 1) ^ -(n & 1);
}

function _pcEncodeZigzagVarint(n: number): Uint8Array {
  return _pcEncodeVarint(_pcEncodeZigzag(n));
}

function _pcDecodeZigzagVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
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

// Pure-JS UTF-8 codec. Lynx's QuickJS runtime has no TextEncoder/TextDecoder
// globals, so the postcard string helpers must not depend on them.
function _utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate → combine with following low surrogate into one codepoint
      const low = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function _utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const adj = cp - 0x10000; // encode as UTF-16 surrogate pair
      s += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
      i += 4;
    } else {
      i += 1; // invalid lead byte — skip
    }
  }
  return s;
}

function _pcEncodeString(s: string): Uint8Array {
  const bytes = _utf8Encode(s);
  return _pcConcatUint8Arrays([_pcEncodeVarint(bytes.length), bytes]);
}

function _pcDecodeString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len = _pcDecodeVarint(buf, offset);
  const start = offset + len.bytesRead;
  const end = start + len.value;
  return {
    value: _utf8Decode(buf, start, end),
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

import type { RkyvV2Codec, RustraError } from '@rustra/types';
import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, Item, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';

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

  decode(buf: ArrayBuffer): { ok: boolean; result?: CreateItemOutput; error?: RustraError } {
    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
      if (errLen > 0) {
        // postcard({ code: String, message: String })
        const c = _pcDecodeString(u8, 10);
        const m = _pcDecodeString(u8, 10 + c.bytesRead);
        err = { code: c.value, message: m.value };
      }
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: DeleteItemOutput; error?: RustraError } {
    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
      if (errLen > 0) {
        // postcard({ code: String, message: String })
        const c = _pcDecodeString(u8, 10);
        const m = _pcDecodeString(u8, 10 + c.bytesRead);
        err = { code: c.value, message: m.value };
      }
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: GetItemOutput; error?: RustraError } {
    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
      if (errLen > 0) {
        // postcard({ code: String, message: String })
        const c = _pcDecodeString(u8, 10);
        const m = _pcDecodeString(u8, 10 + c.bytesRead);
        err = { code: c.value, message: m.value };
      }
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: ListItemsOutput; error?: RustraError } {
    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
      if (errLen > 0) {
        // postcard({ code: String, message: String })
        const c = _pcDecodeString(u8, 10);
        const m = _pcDecodeString(u8, 10 + c.bytesRead);
        err = { code: c.value, message: m.value };
      }
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: UpdateItemOutput; error?: RustraError } {
    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8[0] !== 1) {
      const errLen = view.getUint16(8, true);
      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
      if (errLen > 0) {
        // postcard({ code: String, message: String })
        const c = _pcDecodeString(u8, 10);
        const m = _pcDecodeString(u8, 10 + c.bytesRead);
        err = { code: c.value, message: m.value };
      }
      return { ok: false, error: err };
    }
    return { ok: true, result: {} as UpdateItemOutput };
  },
};

