// ── rustra generated ────────────────────────────────────────
// File:   rkyv-codecs.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts codec renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

// ── postcard wire format helpers ─────────────────────────────

const _dvScratchBuf = new ArrayBuffer(8);
const _dvScratch = new DataView(_dvScratchBuf);
const _dvScratchU8 = new Uint8Array(_dvScratchBuf);

function _pcEncodeVarint(n: number): Uint8Array {
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

function _pcEncodeZigzag(n: number): number { return n >= 0 ? n * 2 : -n * 2 - 1; }
function _pcDecodeZigzag(n: number): number {
  const negative = n % 2 === 1;
  const magnitude = Math.floor(n / 2);
  return negative ? -magnitude - 1 : magnitude;
}
function _pcEncodeZigzagVarint(n: number): Uint8Array { return _pcEncodeVarint(_pcEncodeZigzag(n)); }
function _pcDecodeZigzagVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  const { value, bytesRead } = _pcDecodeVarint(buf, offset);
  return { value: _pcDecodeZigzag(value), bytesRead };
}

const _pcI64Min = -(2n ** 63n);
const _pcI64Max = 2n ** 63n - 1n;

function _pcEncodeVarint64(v: number | bigint): Uint8Array {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return _pcEncodeVarint(v);
  let value = BigInt(v);
  if (value < 0n) throw new Error('varint must be non-negative: ' + value.toString());
  if (value > 0xffffffffffffffffn) throw new Error('varint exceeds u64 range: ' + value.toString());
  const bytes: number[] = [];
  do {
    let next = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) next |= 0x80;
    bytes.push(next);
  } while (value !== 0n);
  return new Uint8Array(bytes);
}

function _pcDecodeVarint64(buf: Uint8Array, offset: number): { value: number | bigint; bytesRead: number } {
  let num = 0;
  let multiplier = 1;
  let big = 0n;
  let bytesRead = 0;
  while (true) {
    const b = buf[offset + bytesRead];
    if (b === undefined) throw new Error('varint out of bounds');
    bytesRead++;
    if (bytesRead <= 7) {
      num += (b & 0x7f) * multiplier;
      multiplier *= 128;
      if ((b & 0x80) === 0) return { value: num, bytesRead };
    } else {
      if (bytesRead === 8) big = BigInt(num);
      big |= BigInt(b & 0x7f) << BigInt(7 * (bytesRead - 1));
      if ((b & 0x80) === 0) {
        if (bytesRead === 10 && (b & 0x7f) > 0x01) throw new Error('varint exceeds 64 bits');
        const asNumber = Number(big);
        return { value: Number.isSafeInteger(asNumber) ? asNumber : big, bytesRead };
      }
    }
    if (bytesRead >= 10) throw new Error('varint too long');
  }
}

function _pcEncodeZigzag64(v: number | bigint): Uint8Array {
  const n = BigInt(v);
  if (n < _pcI64Min || n > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + n.toString());
  return _pcEncodeVarint64((n << 1n) ^ (n >> 63n));
}
function _pcDecodeZigzag64(v: number | bigint): number | bigint {
  const decoded = (BigInt(v) >> 1n) ^ -(BigInt(v) & 1n);
  const asNumber = Number(decoded);
  return Number.isSafeInteger(asNumber) ? asNumber : decoded;
}

function _pcConcatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

function _utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const low = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

function _utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  let s = ''; let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
    else if ((b & 0xe0) === 0xc0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if ((b & 0xf0) === 0xe0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else if ((b & 0xf8) === 0xf0) { const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); const adj = cp - 0x10000; s += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff)); i += 4; }
    else i += 1;
  }
  return s;
}

function _pcEncodeString(s: string): Uint8Array { const bytes = _utf8Encode(s); return _pcConcatUint8Arrays([_pcEncodeVarint(bytes.length), bytes]); }
function _pcDecodeString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len = _pcDecodeVarint(buf, offset); const start = offset + len.bytesRead; const end = start + len.value;
  return { value: _utf8Decode(buf, start, end), bytesRead: len.bytesRead + len.value };
}

function _pcEncodeF64(n: number): Uint8Array { const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, n, true); return new Uint8Array(buf); }
function _pcDecodeF64(buf: Uint8Array, offset: number): { value: number; bytesRead: number } { return { value: new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true), bytesRead: 8 }; }
function _pcEncodeF32(n: number): Uint8Array { const buf = new ArrayBuffer(4); new DataView(buf).setFloat32(0, n, true); return new Uint8Array(buf); }
function _pcDecodeF32(buf: Uint8Array, offset: number): { value: number; bytesRead: number } { return { value: new DataView(buf.buffer, buf.byteOffset + offset, 4).getFloat32(0, true), bytesRead: 4 }; }

import { createComplexCodec } from '@rustra/types';
import type { RkyvV2Codec, RustraError, ComplexSchema } from '@rustra/types';
import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ChannelHandle, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, Item, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandle, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';

export const addNumbersCodec: RkyvV2Codec<AddNumbersInput, AddNumbersOutput> = {
  commandId: 1,

  encode(args: AddNumbersInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(AddNumbersInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 1, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzag64(args.a));
    parts.push(_pcEncodeZigzag64(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: AddNumbersInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 1; out[w++] = 0;
    { let _x = BigInt(args.a); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    { let _x = BigInt(args.b); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.value = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as AddNumbersOutput };
  },
};

export const benchAddCodec: RkyvV2Codec<BenchAddInput, BenchAddOutput> = {
  commandId: 23,

  encode(args: BenchAddInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(BenchAddInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 23, true);
    parts.push(cmdId);
    parts.push(_pcEncodeF64(args.a));
    parts.push(_pcEncodeF64(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: BenchAddInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 23; out[w++] = 0;
    { ensure(8); _dvScratch.setFloat64(0, args.a, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    { ensure(8); _dvScratch.setFloat64(0, args.b, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: BenchAddOutput; error?: RustraError } {
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
    const result: Partial<BenchAddOutput> = {};
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as BenchAddOutput };
  },
};

export const benchEchoBytesCodec: RkyvV2Codec<BenchBytesPayload, BenchBytesPayload> = {
  commandId: 25,

  encode(args: BenchBytesPayload): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(BenchBytesPayload)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 25, true);
    parts.push(cmdId);
    {
      const _b = args.data;
      const _u = _b instanceof Uint8Array ? _b : new Uint8Array(_b);
      parts.push(_pcEncodeVarint(_u.length));
      parts.push(_u);
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: BenchBytesPayload, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 25; out[w++] = 0;
    { const _b = args.data; const _u = typeof _b === 'string' ? _utf8Encode(_b) : _b instanceof Uint8Array ? _b : new Uint8Array(_b); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: BenchBytesPayload; error?: RustraError } {
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
    const result: Partial<BenchBytesPayload> = {};
    {
      const _len = _pcDecodeVarint(u8, offset);
      offset += _len.bytesRead;
      result.data = u8.slice(offset, offset + _len.value);
      offset += _len.value;
    }
    return { ok: true, result: result as BenchBytesPayload };
  },
};

export const benchEchoPairCodec: RkyvV2Codec<BenchPairPayload, BenchPairPayload> = {
  commandId: 26,

  encode(args: BenchPairPayload): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(BenchPairPayload)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 26, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.name));
    parts.push(_pcEncodeF64(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: BenchPairPayload, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 26; out[w++] = 0;
    { const _s = args.name; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    { ensure(8); _dvScratch.setFloat64(0, args.value, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: BenchPairPayload; error?: RustraError } {
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
    const result: Partial<BenchPairPayload> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.name = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeF64(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as BenchPairPayload };
  },
};

export const benchEchoStringCodec: RkyvV2Codec<BenchStringPayload, BenchStringPayload> = {
  commandId: 24,

  encode(args: BenchStringPayload): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(BenchStringPayload)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 24, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: BenchStringPayload, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 24; out[w++] = 0;
    { const _s = args.value; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: BenchStringPayload; error?: RustraError } {
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
    const result: Partial<BenchStringPayload> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.value = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as BenchStringPayload };
  },
};

export const channelDemoCodec: RkyvV2Codec<ChannelDemoInput, ChannelDemoOutput> = {
  commandId: 18,

  encode(args: ChannelDemoInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ChannelDemoInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 18, true);
    parts.push(cmdId);
    parts.push(_pcEncodeVarint(args.channel));
    parts.push(_pcEncodeZigzagVarint(args.ticks));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: ChannelDemoInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 18; out[w++] = 0;
    { let _v = args.channel; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    { const _z = args.ticks >= 0 ? args.ticks * 2 : -args.ticks * 2 - 1; let _v = _z; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ChannelDemoOutput; error?: RustraError } {
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
    const result: Partial<ChannelDemoOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.sent = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.droppedSends = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ChannelDemoOutput };
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

  encodeInto(args: ClampInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 4; out[w++] = 0;
    { ensure(8); _dvScratch.setFloat64(0, args.max, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    { ensure(8); _dvScratch.setFloat64(0, args.min, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    { ensure(8); _dvScratch.setFloat64(0, args.value, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    return out.subarray(0, w);
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
    parts.push(_pcEncodeZigzag64(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: CreateItemInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 8; out[w++] = 0;
    { const _s = args.name; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    { let _x = BigInt(args.value); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
        const _v = _pcDecodeVarint64(u8, offset);
        _obj.value = _pcDecodeZigzag64(_v.value);
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
    parts.push(_pcEncodeZigzag64(args.a));
    parts.push(_pcEncodeZigzag64(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: DivideInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 10; out[w++] = 0;
    { let _x = BigInt(args.a); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    { let _x = BigInt(args.b); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.value = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as DivideOutput };
  },
};

/** route: complex-binary; RN uses native C++ when the schema is native-safe, otherwise JS. */
export const echoGroupsComplexCodec: RkyvV2Codec<EchoGroupsInput, EchoGroupsOutput> = createComplexCodec<EchoGroupsInput, EchoGroupsOutput>({
  commandId: 27,
  inputSchema: {"title":"EchoGroupsInput","type":"object","required":["groups"],"properties":{"groups":{"type":"object","additionalProperties":{"type":"array","items":{"type":"string"}}}}} as ComplexSchema,
  outputSchema: {"title":"EchoGroupsOutput","type":"object","required":["groups"],"properties":{"groups":{"type":"object","additionalProperties":{"type":"array","items":{"type":"string"}}}}} as ComplexSchema,
  definitions: {"ChannelHandle":{"description":"커맨드 인자로 받은 채널 핸들 — serde 표면은 plain `u32`다.\n\n코드젠은 이 타입을 인식하면 TS 를 `RustraChannel` 마커 타입으로 발행한다(런타임 값은 여전히 number — wire 는 u32 varint).","type":"integer","format":"uint32","minimum":0},"Item":{"type":"object","required":["active","name","value"],"properties":{"active":{"type":"boolean"},"name":{"type":"string"},"value":{"type":"integer","format":"int64"}}},"ResourceHandle":{"description":"커맨드 반환값/필드로 받은 리소스 핸들 — serde 표면은 plain `u32`.","type":"integer","format":"uint32","minimum":0}} as Record<string, ComplexSchema>,
});

export const echoGroupsCodec = echoGroupsComplexCodec;

export const emitDemoCodec: RkyvV2Codec<EmitDemoInput, EmitDemoOutput> = {
  commandId: 11,

  encode(args: EmitDemoInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(EmitDemoInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 11, true);
    parts.push(cmdId);
    parts.push(_pcEncodeZigzag64(args.ticks));
    parts.push(_pcEncodeZigzag64(args.stepDelayMs));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: EmitDemoInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 11; out[w++] = 0;
    { let _x = BigInt(args.ticks); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    { let _x = BigInt(args.stepDelayMs); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.emitted = _pcDecodeZigzag64(_v.value);
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
    parts.push(_pcEncodeVarint64(args.limit));
    parts.push(_pcEncodeVarint(args.offset));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: GaugeInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 17; out[w++] = 0;
    { const _v = args.limit; if (typeof _v === 'number' && Number.isSafeInteger(_v) && _v >= 0) { let _x = _v; do { ensure(1); out[w++] = (_x % 128) | 0x80; _x = Math.floor(_x / 128); } while (_x > 0); out[w - 1] &= 0x7f; } else { const _b = BigInt(_v); if (_b < 0n) throw new Error('varint must be non-negative: ' + _b.toString()); if (_b > 0xffffffffffffffffn) throw new Error('varint exceeds u64 range: ' + _b.toString()); let _x = _b; do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; } }
    { let _v = args.offset; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
      const _v = _pcDecodeVarint64(u8, offset);
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

  encodeInto(args: GreetInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 5; out[w++] = 0;
    { const _s = args.name; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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
    parts.push(_pcEncodeZigzag64(args.n));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: IsEvenInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 3; out[w++] = 0;
    { let _x = BigInt(args.n); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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

  encodeInto(args: MultiplyInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 2; out[w++] = 0;
    { ensure(8); _dvScratch.setFloat64(0, args.a, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    { ensure(8); _dvScratch.setFloat64(0, args.b, true); for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }
    return out.subarray(0, w);
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
    parts.push(_pcEncodeZigzag64(args.item.value));
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
        const _v = _pcDecodeVarint64(u8, offset);
        _obj.value = _pcDecodeZigzag64(_v.value);
        offset += _v.bytesRead;
      }
      result.item = _obj;
    }
    return { ok: true, result: result as ProcessItemOutput };
  },
};

export const resourceCloseCodec: RkyvV2Codec<ResourceCloseInput, ResourceCloseOutput> = {
  commandId: 22,

  encode(args: ResourceCloseInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ResourceCloseInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 22, true);
    parts.push(cmdId);
    parts.push(_pcEncodeVarint(args.handle));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: ResourceCloseInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 22; out[w++] = 0;
    { let _v = args.handle; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ResourceCloseOutput; error?: RustraError } {
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
    const result: Partial<ResourceCloseOutput> = {};
    {
      result.closed = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result: result as ResourceCloseOutput };
  },
};

export const resourceOpenCodec: RkyvV2Codec<ResourceOpenInput, ResourceHandleOutput> = {
  commandId: 19,

  encode(args: ResourceOpenInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ResourceOpenInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 19, true);
    parts.push(cmdId);
    {
      const _map = args.initial;
      const _keys = Object.keys(_map).sort();
      parts.push(_pcEncodeVarint(_keys.length));
      for (const _k of _keys) {
        const _v = _map[_k];
        parts.push(_pcEncodeString(_k));
        parts.push(_pcEncodeString(_v));
      }
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ResourceHandleOutput; error?: RustraError } {
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
    const result: Partial<ResourceHandleOutput> = {};
    {
      const _v = _pcDecodeVarint(u8, offset);
      result.handle = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ResourceHandleOutput };
  },
};

export const resourceReadCodec: RkyvV2Codec<ResourceReadInput, ResourceReadOutput> = {
  commandId: 20,

  encode(args: ResourceReadInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ResourceReadInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 20, true);
    parts.push(cmdId);
    parts.push(_pcEncodeVarint(args.handle));
    parts.push(_pcEncodeString(args.key));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: ResourceReadInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 20; out[w++] = 0;
    { let _v = args.handle; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    { const _s = args.key; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ResourceReadOutput; error?: RustraError } {
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
    const result: Partial<ResourceReadOutput> = {};
    {
      result.found = u8[offset] === 1;
      offset += 1;
    }
    {
      const _tag = u8[offset];
      offset += 1;
      if (_tag === 0) {
        result.value = null;
      } else {
        {
          const _v = _pcDecodeString(u8, offset);
          result.value = _v.value;
          offset += _v.bytesRead;
        }
      }
    }
    return { ok: true, result: result as ResourceReadOutput };
  },
};

export const resourceWriteCodec: RkyvV2Codec<ResourceWriteInput, ResourceWriteOutput> = {
  commandId: 21,

  encode(args: ResourceWriteInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(ResourceWriteInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 21, true);
    parts.push(cmdId);
    parts.push(_pcEncodeVarint(args.handle));
    parts.push(_pcEncodeString(args.key));
    parts.push(_pcEncodeString(args.value));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: ResourceWriteInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 21; out[w++] = 0;
    { let _v = args.handle; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }
    { const _s = args.key; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    { const _s = args.value; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: ResourceWriteOutput; error?: RustraError } {
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
    const result: Partial<ResourceWriteOutput> = {};
    {
      const _v = _pcDecodeZigzagVarint(u8, offset);
      result.entries = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as ResourceWriteOutput };
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

  encodeInto(args: RegistryDemoInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 12; out[w++] = 0;
    { const _s = args.op; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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
        parts.push(_pcEncodeZigzag64(_v));
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.total = _pcDecodeZigzag64(_v.value);
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
    parts.push(_pcEncodeZigzag64(args.a));
    parts.push(_pcEncodeZigzag64(args.b));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: SecureComputeInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 13; out[w++] = 0;
    { let _x = BigInt(args.a); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    { let _x = BigInt(args.b); if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); _x = (_x << 1n) ^ (_x >> 63n); do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }
    return out.subarray(0, w);
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.value = _pcDecodeZigzag64(_v.value);
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
      const _u = _b instanceof Uint8Array ? _b : new Uint8Array(_b);
      parts.push(_pcEncodeVarint(_u.length));
      parts.push(_u);
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: SizeOfInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 14; out[w++] = 0;
    { const _b = args.data; const _u = typeof _b === 'string' ? _utf8Encode(_b) : _b instanceof Uint8Array ? _b : new Uint8Array(_b); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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
      parts.push(_pcEncodeZigzag64(args.pair[1]));
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.second = _pcDecodeZigzag64(_v.value);
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
        parts.push(_pcEncodeZigzag64(_arr[_i]));
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
      const _v = _pcDecodeVarint64(u8, offset);
      result.total = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as SumListOutput };
  },
};

/** route: complex-binary; RN uses native C++ when the schema is native-safe, otherwise JS. */
export const tagSetComplexCodec: RkyvV2Codec<TagSetInput, TagSetOutput> = createComplexCodec<TagSetInput, TagSetOutput>({
  commandId: 29,
  inputSchema: {"title":"TagSetInput","type":"object","required":["ids"],"properties":{"ids":{"type":"array","items":{"type":"integer","format":"int64"},"uniqueItems":true}}} as ComplexSchema,
  outputSchema: {"title":"TagSetOutput","type":"object","required":["tags"],"properties":{"tags":{"type":"array","items":{"type":"string"},"uniqueItems":true}}} as ComplexSchema,
  definitions: {"ChannelHandle":{"description":"커맨드 인자로 받은 채널 핸들 — serde 표면은 plain `u32`다.\n\n코드젠은 이 타입을 인식하면 TS 를 `RustraChannel` 마커 타입으로 발행한다(런타임 값은 여전히 number — wire 는 u32 varint).","type":"integer","format":"uint32","minimum":0},"Item":{"type":"object","required":["active","name","value"],"properties":{"active":{"type":"boolean"},"name":{"type":"string"},"value":{"type":"integer","format":"int64"}}},"ResourceHandle":{"description":"커맨드 반환값/필드로 받은 리소스 핸들 — serde 표면은 plain `u32`.","type":"integer","format":"uint32","minimum":0}} as Record<string, ComplexSchema>,
});

export const tagSetCodec = tagSetComplexCodec;

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

  encodeInto(args: ToUpperInput, reuse?: Uint8Array): Uint8Array {
    let out = reuse ?? new Uint8Array(64);
    let w = 0;
    const ensure = (need: number) => {
      if (w + need <= out.length) return;
      const grown = new Uint8Array(Math.max(out.length * 2, w + need));
      grown.set(out.subarray(0, w));
      out = grown;
    };
    ensure(2);
    out[w++] = 7; out[w++] = 0;
    { const _s = args.s; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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

export const wideAggCodec: RkyvV2Codec<WideAggInput, WideAggOutput> = {
  commandId: 28,

  encode(args: WideAggInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(WideAggInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 28, true);
    parts.push(cmdId);
    {
      const _arr = args.samples;
      parts.push(_pcEncodeVarint(_arr.length));
      for (let _i = 0; _i < _arr.length; _i++) {
        parts.push(_pcEncodeVarint64(_arr[_i]));
      }
    }
    {
      const _opt = args.offset;
      if (_opt === null || _opt === undefined) {
        parts.push(new Uint8Array([0]));
      } else {
        parts.push(new Uint8Array([1]));
        parts.push(_pcEncodeZigzag64(_opt));
      }
    }
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: WideAggOutput; error?: RustraError } {
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
    const result: Partial<WideAggOutput> = {};
    {
      const _v = _pcDecodeVarint64(u8, offset);
      result.max = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeVarint64(u8, offset);
      result.adjusted = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as WideAggOutput };
  },
};
