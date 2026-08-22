// ── postcard wire format helpers ─────────────────────────────

function _pcEncodeVarint(n: number): Uint8Array {
  // 정수만 허용 — u32 최대(4,294,967,295)는 Number 로 정확히 표현된다.
  // u64 는 2^53 까지 정확 (JS Number 한계; 그 이상은 정밀도 손실 — 계약 문서 참조).
  n = Math.floor(n);
  if (n < 0) throw new Error('varint must be non-negative: ' + n);
  if (n === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  while (n > 0) {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b += 128;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

function _pcDecodeVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  // Number 산술로 2^53 까지 정확히 디코딩 (비트 시프트는 32비트 절단됨).
  // u64 varint 최대 길이 10바이트 — 과거 5바이트 한계는 u32 전용이었다.
  let value = 0;
  let multiplier = 1;
  let bytesRead = 0;
  while (true) {
    const b = buf[offset + bytesRead];
    value += (b & 0x7f) * multiplier;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    multiplier *= 128;
    if (bytesRead > 10) throw new Error('varint too long');
  }
  return { value, bytesRead };
}

function _pcEncodeZigzag(n: number): number {
  // zigzag encode: positive n -> n*2, negative n -> (-n)*2 - 1.
  // Number 산술 — |n| ≤ 2^31 범위 i64 는 32비트 비트연산보다 정확하다
  // (비트연산은 부호 있는 32비트로 절단됨).
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function _pcDecodeZigzag(n: number): number {
  // zigzag decode: (n >>> 1) ^ -(n & 1). 음수는 -(Math.floor(n / 2) + 1) —
  // (n-1)/2 가 아니라 내림 나눗셈이어야 한다(dec(9) = -5, not -4).
  const negative = n % 2 === 1;
  const magnitude = Math.floor(n / 2);
  return negative ? -magnitude - 1 : magnitude;
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

// Pure-JS UTF-8 codec. 임베디드 JS 런타임(예: Hermes)에는 TextEncoder/TextDecoder
// 글로벌이 없을 수 있으므로 postcard 문자열 헬퍼는 이에 의존하지 않는다.
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
import type { AddNumbersInput, AddNumbersOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, Item, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, ToUpperInput, ToUpperOutput } from './types.js';

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

  decode(buf: ArrayBuffer): { ok: boolean; result?: AddNumbersOutput; error?: RustraError } {
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
    const result: Partial<AddNumbersOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as AddNumbersOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: ClampOutput; error?: RustraError } {
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
    const result: Partial<ClampOutput> = {};
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ClampOutput };
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
    return { ok: true, result: result as CreateItemOutput };
  },
};

export const divideCodec: RkyvV2Codec<DivideInput, DivideOutput> = {
  commandId: 10,

  encode(args: DivideInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(DivideInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 10, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzagVarint(args.a));
    parts.push(_pcEncodeZigzagVarint(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: DivideOutput; error?: RustraError } {
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
    const result: Partial<DivideOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as DivideOutput };
  },
};

export const emitDemoCodec: RkyvV2Codec<EmitDemoInput, EmitDemoOutput> = {
  commandId: 11,

  encode(args: EmitDemoInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(EmitDemoInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 11, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzagVarint(args.ticks));
    parts.push(_pcEncodeZigzagVarint(args.stepDelayMs));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: EmitDemoOutput; error?: RustraError } {
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
    const result: Partial<EmitDemoOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.emitted = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as EmitDemoOutput };
  },
};

export const gaugeCodec: RkyvV2Codec<GaugeInput, GaugeOutput> = {
  commandId: 17,

  encode(args: GaugeInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(GaugeInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 17, true);
    parts.push(cmdId);
    parts.push(_pcEncodeVarint(args.limit));
    parts.push(_pcEncodeVarint(args.offset));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: GaugeOutput; error?: RustraError } {
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
    const result: Partial<GaugeOutput> = {};
    {
      const _v = _pcDecodeVarint(u8, offset);
      result.next = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as GaugeOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: GreetOutput; error?: RustraError } {
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
    const result: Partial<GreetOutput> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.message = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as GreetOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: IsEvenOutput; error?: RustraError } {
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
    const result: Partial<IsEvenOutput> = {};
    {
      result.result = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result: result as IsEvenOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: MultiplyOutput; error?: RustraError } {
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
    const result: Partial<MultiplyOutput> = {};
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as MultiplyOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: ProcessItemOutput; error?: RustraError } {
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
    const result: Partial<ProcessItemOutput> = {};
    {
      result.doubled = u8[offset] === 1;
      offset += 1;
    }
    {
      const _obj: Item = {} as Item;
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
    return { ok: true, result: result as ProcessItemOutput };
  },
};

export const rustraRegistryDemoCodec: RkyvV2Codec<RegistryDemoInput, RegistryDemoOutput> = {
  commandId: 12,

  encode(args: RegistryDemoInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(RegistryDemoInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 12, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.op));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: RegistryDemoOutput; error?: RustraError } {
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
    const result: Partial<RegistryDemoOutput> = {};
    {
      result.ok = u8[offset] === 1;
      offset += 1;
    }
    {
      result.frozen = u8[offset] === 1;
      offset += 1;
    }
    {
      const _v = _pcDecodeString(u8, offset);
      result.message = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as RegistryDemoOutput };
  },
};

export const scoreTotalCodec: RkyvV2Codec<ScoreTotalInput, ScoreTotalOutput> = {
  commandId: 15,

  encode(args: ScoreTotalInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ScoreTotalInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 15, true);
    parts.push(cmdId);
    {
      const _map = args.scores;
      const _keys = Object.keys(_map).sort();
      parts.push(_pcEncodeVarint(_keys.length));
      for (const _k of _keys) {
        const _v = _map[_k];
        parts.push(_pcEncodeString(_k));
        parts.push(_pcEncodeZigzagVarint(_v));
      }
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ScoreTotalOutput; error?: RustraError } {
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
    const result: Partial<ScoreTotalOutput> = {};
    {
      const _v = _pcDecodeVarint(u8, offset);
      result.count = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.total = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ScoreTotalOutput };
  },
};

export const secureComputeCodec: RkyvV2Codec<SecureComputeInput, SecureComputeOutput> = {
  commandId: 13,

  encode(args: SecureComputeInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SecureComputeInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 13, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzagVarint(args.a));
    parts.push(_pcEncodeZigzagVarint(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SecureComputeOutput; error?: RustraError } {
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
    const result: Partial<SecureComputeOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as SecureComputeOutput };
  },
};

export const sizeOfCodec: RkyvV2Codec<SizeOfInput, SizeOfOutput> = {
  commandId: 14,

  encode(args: SizeOfInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SizeOfInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 14, true);
    parts.push(cmdId);
    {
      const _b = args.data;
      parts.push(_pcEncodeVarint(_b.length));
      parts.push(typeof _b === 'string' ? _utf8Encode(_b) : new Uint8Array(_b));
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SizeOfOutput; error?: RustraError } {
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
    const result: Partial<SizeOfOutput> = {};
    {
      const _v = _pcDecodeVarint(u8, offset);
      result.checksum = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeVarint(u8, offset);
      result.len = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as SizeOfOutput };
  },
};

export const spanCodec: RkyvV2Codec<SpanInput, SpanOutput> = {
  commandId: 16,

  encode(args: SpanInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SpanInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 16, true);
    parts.push(cmdId);
    {
      parts.push(_pcEncodeString(args.pair[0]));
      parts.push(_pcEncodeZigzagVarint(args.pair[1]));
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SpanOutput; error?: RustraError } {
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
    const result: Partial<SpanOutput> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.first = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.second = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as SpanOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: SumListOutput; error?: RustraError } {
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
    const result: Partial<SumListOutput> = {};
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
    return { ok: true, result: result as SumListOutput };
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: ToUpperOutput; error?: RustraError } {
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
    const result: Partial<ToUpperOutput> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.result = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ToUpperOutput };
  },
};

