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
  AddNumbersInput,
  AddNumbersOutput,
  ClampInput,
  ClampOutput,
  CreateItemInput,
  CreateItemOutput,
  GreetInput,
  GreetOutput,
  IsEvenInput,
  IsEvenOutput,
  MultiplyInput,
  MultiplyOutput,
  ProcessItemInput,
  ProcessItemOutput,
  SumListInput,
  SumListOutput,
  ToUpperInput,
  ToUpperOutput,
} from './types.js';

export const addNumbersCodec: RkyvV2Codec<AddNumbersInput, AddNumbersOutput> = {
  commandId: 1,

  encode(args: AddNumbersInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(AddNumbersInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 1, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzagVarint(args.a));
    parts.push(_pcEncodeZigzagVarint(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: AddNumbersOutput; error?: string } {
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
    const result: AddNumbersOutput = {} as any;
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};

export const clampCodec: RkyvV2Codec<ClampInput, ClampOutput> = {
  commandId: 4,

  encode(args: ClampInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ClampInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 4, true);
    parts.push(cmdId);
    parts.push(_pcEncodeF64(args.max));
    parts.push(_pcEncodeF64(args.min));
    parts.push(_pcEncodeF64(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ClampOutput; error?: string } {
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
    const result: ClampOutput = {} as any;
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};

export const createItemCodec: RkyvV2Codec<CreateItemInput, CreateItemOutput> = {
  commandId: 8,

  encode(args: CreateItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(CreateItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 8, true);
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
    const result: CreateItemOutput = {} as any;
    {
      const _obj: any = {};
      {
        _obj.active = u8[offset] === 1;
        offset += 1;
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
    return { ok: true, result };
  },
};

export const greetCodec: RkyvV2Codec<GreetInput, GreetOutput> = {
  commandId: 5,

  encode(args: GreetInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(GreetInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 5, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.name));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: GreetOutput; error?: string } {
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
    const result: GreetOutput = {} as any;
    {
      const _v = _pcDecodeString(u8, offset);
      result.message = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};

export const isEvenCodec: RkyvV2Codec<IsEvenInput, IsEvenOutput> = {
  commandId: 3,

  encode(args: IsEvenInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(IsEvenInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 3, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzagVarint(args.n));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: IsEvenOutput; error?: string } {
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
    const result: IsEvenOutput = {} as any;
    {
      result.result = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result };
  },
};

export const multiplyCodec: RkyvV2Codec<MultiplyInput, MultiplyOutput> = {
  commandId: 2,

  encode(args: MultiplyInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(MultiplyInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 2, true);
    parts.push(cmdId);
    parts.push(_pcEncodeF64(args.a));
    parts.push(_pcEncodeF64(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: MultiplyOutput; error?: string } {
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
    const result: MultiplyOutput = {} as any;
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};

export const processItemCodec: RkyvV2Codec<ProcessItemInput, ProcessItemOutput> = {
  commandId: 9,

  encode(args: ProcessItemInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ProcessItemInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 9, true);
    parts.push(cmdId);
    parts.push(new Uint8Array([args.item.active ? 1 : 0]));
    parts.push(_pcEncodeString(args.item.name));
    parts.push(_pcEncodeZigzagVarint(args.item.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ProcessItemOutput; error?: string } {
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
    const result: ProcessItemOutput = {} as any;
    {
      result.doubled = u8[offset] === 1;
      offset += 1;
    }
    {
      const _obj: any = {};
      {
        _obj.active = u8[offset] === 1;
        offset += 1;
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
    return { ok: true, result };
  },
};

export const sumListCodec: RkyvV2Codec<SumListInput, SumListOutput> = {
  commandId: 6,

  encode(args: SumListInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SumListInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 6, true);
    parts.push(cmdId);
    {
      const _arr = args.numbers;
      parts.push(_pcEncodeVarint(_arr.length));
      for (let _i = 0; _i < _arr.length; _i++) {
        parts.push(_pcEncodeZigzagVarint(_arr[_i]));
      }
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SumListOutput; error?: string } {
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
    const result: SumListOutput = {} as any;
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.count = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.total = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};

export const toUpperCodec: RkyvV2Codec<ToUpperInput, ToUpperOutput> = {
  commandId: 7,

  encode(args: ToUpperInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ToUpperInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 7, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.s));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ToUpperOutput; error?: string } {
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
    const result: ToUpperOutput = {} as any;
    {
      const _v = _pcDecodeString(u8, offset);
      result.result = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result };
  },
};
