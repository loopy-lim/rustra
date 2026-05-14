import type { RkyvV2Codec } from '@rustra/types';
import type { AddNumbersInput, AddNumbersOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';

export const addNumbersCodec: RkyvV2Codec<AddNumbersInput, AddNumbersOutput> = {
  commandId: 1,
  encode(args: AddNumbersInput): ArrayBuffer {
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    view.setUint16(0, 1, true);
    view.setInt32(8, args.a, true);
    view.setInt32(12, args.a >= 0 ? 0 : -1, true);
    view.setInt32(16, args.b, true);
    view.setInt32(20, args.b >= 0 ? 0 : -1, true);
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: AddNumbersOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: AddNumbersOutput = {} as any;
    result.value = view.getInt32(8, true);
    return { ok: true, result };
  },
};

export const clampCodec: RkyvV2Codec<ClampInput, ClampOutput> = {
  commandId: 4,
  encode(args: ClampInput): ArrayBuffer {
    const buf = new ArrayBuffer(32);
    const view = new DataView(buf);
    view.setUint16(0, 4, true);
    view.setFloat64(8, args.max, true);
    view.setFloat64(16, args.min, true);
    view.setFloat64(24, args.value, true);
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: ClampOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: ClampOutput = {} as any;
    result.value = view.getFloat64(8, true);
    return { ok: true, result };
  },
};

export const createItemCodec: RkyvV2Codec<CreateItemInput, CreateItemOutput> = {
  commandId: 8,

  encode(args: CreateItemInput): ArrayBuffer {
    const json = JSON.stringify(args);
    const jsonBytes = new TextEncoder().encode(json);
    const buf = new ArrayBuffer(2 + jsonBytes.length);
    const view = new DataView(buf);
    view.setUint16(0, 8, true);
    new Uint8Array(buf, 2).set(jsonBytes);
    return buf;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: CreateItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    // Tier 3 success: [ok=1 @0][pad 3B][json_len: u32 @4 LE][json_bytes @8...]
    const jsonLen = view.getUint32(4, true);
    const jsonStr = new TextDecoder().decode(u8.slice(8, 8 + jsonLen));
    const result: CreateItemOutput = JSON.parse(jsonStr);
    return { ok: true, result };
  },
};

export const greetCodec: RkyvV2Codec<GreetInput, GreetOutput> = {
  commandId: 5,
  encode(args: GreetInput): ArrayBuffer {
    const nameBytes = new TextEncoder().encode(args.name);
    const buf = new ArrayBuffer(8 + 4 + nameBytes.length);
    const view = new DataView(buf);
    view.setUint16(0, 5, true);
    let cursor = 8;
    view.setUint32(cursor, nameBytes.length, true);
    new Uint8Array(buf, cursor + 4).set(nameBytes);
    cursor += 4 + nameBytes.length;
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: GreetOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: GreetOutput = {} as any;
    let cursor = 8;
    {
      const len = view.getUint32(cursor, true);
      cursor += 4;
      result.message = new TextDecoder().decode(u8.slice(cursor, cursor + len));
      cursor += len;
    }
    return { ok: true, result };
  },
};

export const isEvenCodec: RkyvV2Codec<IsEvenInput, IsEvenOutput> = {
  commandId: 3,
  encode(args: IsEvenInput): ArrayBuffer {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint16(0, 3, true);
    view.setInt32(8, args.n, true);
    view.setInt32(12, args.n >= 0 ? 0 : -1, true);
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: IsEvenOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: IsEvenOutput = {} as any;
    result.result = u8[8] === 1;
    return { ok: true, result };
  },
};

export const multiplyCodec: RkyvV2Codec<MultiplyInput, MultiplyOutput> = {
  commandId: 2,
  encode(args: MultiplyInput): ArrayBuffer {
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    view.setUint16(0, 2, true);
    view.setFloat64(8, args.a, true);
    view.setFloat64(16, args.b, true);
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: MultiplyOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: MultiplyOutput = {} as any;
    result.value = view.getFloat64(8, true);
    return { ok: true, result };
  },
};

export const processItemCodec: RkyvV2Codec<ProcessItemInput, ProcessItemOutput> = {
  commandId: 9,

  encode(args: ProcessItemInput): ArrayBuffer {
    const json = JSON.stringify(args);
    const jsonBytes = new TextEncoder().encode(json);
    const buf = new ArrayBuffer(2 + jsonBytes.length);
    const view = new DataView(buf);
    view.setUint16(0, 9, true);
    new Uint8Array(buf, 2).set(jsonBytes);
    return buf;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ProcessItemOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    // Tier 3 success: [ok=1 @0][pad 3B][json_len: u32 @4 LE][json_bytes @8...]
    const jsonLen = view.getUint32(4, true);
    const jsonStr = new TextDecoder().decode(u8.slice(8, 8 + jsonLen));
    const result: ProcessItemOutput = JSON.parse(jsonStr);
    return { ok: true, result };
  },
};

export const sumListCodec: RkyvV2Codec<SumListInput, SumListOutput> = {
  commandId: 6,
  encode(args: SumListInput): ArrayBuffer {
    const numbersLen = args.numbers.length;
    const buf = new ArrayBuffer(8 + 4 + numbersLen * 8);
    const view = new DataView(buf);
    view.setUint16(0, 6, true);
    let cursor = 8;
    view.setUint32(cursor, numbersLen * 8, true);
    cursor += 4;
    for (let i = 0; i < numbersLen; i++) {
      const v = args.numbers[i];
      view.setInt32(cursor, v, true);
      view.setInt32(cursor + 4, v >= 0 ? 0 : -1, true);
      cursor += 8;
    }
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: SumListOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: SumListOutput = {} as any;
    result.count = view.getInt32(8, true);
    result.total = view.getInt32(16, true);
    return { ok: true, result };
  },
};

export const toUpperCodec: RkyvV2Codec<ToUpperInput, ToUpperOutput> = {
  commandId: 7,
  encode(args: ToUpperInput): ArrayBuffer {
    const sBytes = new TextEncoder().encode(args.s);
    const buf = new ArrayBuffer(8 + 4 + sBytes.length);
    const view = new DataView(buf);
    view.setUint16(0, 7, true);
    let cursor = 8;
    view.setUint32(cursor, sBytes.length, true);
    new Uint8Array(buf, cursor + 4).set(sBytes);
    cursor += 4 + sBytes.length;
    return buf;
  },
  decode(buf: ArrayBuffer): { ok: boolean; result?: ToUpperOutput; error?: string } {
    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      const errLen = view.getUint16(8, true);
      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';
      return { ok: false, error: err };
    }
    const result: ToUpperOutput = {} as any;
    let cursor = 8;
    {
      const len = view.getUint32(cursor, true);
      cursor += 4;
      result.result = new TextDecoder().decode(u8.slice(cursor, cursor + len));
      cursor += len;
    }
    return { ok: true, result };
  },
};

