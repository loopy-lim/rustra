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
import type { AdminStatsInput, AdminStatsOutput, GrantInput, GrantOutput, SignInInput, SignInOutput, SignOutInput, SignOutOutput } from './types.js';

export const adminStatsCodec: RkyvV2Codec<AdminStatsInput, AdminStatsOutput> = {
  commandId: 4,

  encode(args: AdminStatsInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(AdminStatsInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 4, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.token));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: AdminStatsInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.token; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: AdminStatsOutput; error?: RustraError } {
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
    const result: Partial<AdminStatsOutput> = {};
    {
      const _v = _pcDecodeVarint64(u8, offset);
      result.sessions = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeVarint64(u8, offset);
      result.uptimeMs = _pcDecodeZigzag64(_v.value);
      offset += _v.bytesRead;
    }
    {
      const _len = _pcDecodeVarint(u8, offset);
      offset += _len.bytesRead;
      const _arr: string[] = new Array(_len.value);
      for (let _i = 0; _i < _len.value; _i++) {
        const _v = _pcDecodeString(u8, offset);
        _arr[_i] = _v.value;
        offset += _v.bytesRead;
      }
      result.activeUsers = _arr;
    }
    return { ok: true, result: result as AdminStatsOutput };
  },
};

export const grantCodec: RkyvV2Codec<GrantInput, GrantOutput> = {
  commandId: 3,

  encode(args: GrantInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(GrantInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 3, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.token));
    parts.push(_pcEncodeString(args.capability));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: GrantInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.token; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    { const _s = args.capability; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: GrantOutput; error?: RustraError } {
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
    const result: Partial<GrantOutput> = {};
    {
      result.granted = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result: result as GrantOutput };
  },
};

export const signInCodec: RkyvV2Codec<SignInInput, SignInOutput> = {
  commandId: 1,

  encode(args: SignInInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SignInInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 1, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.username));
    parts.push(_pcEncodeString(args.password));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: SignInInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.username; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    { const _s = args.password; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SignInOutput; error?: RustraError } {
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
    const result: Partial<SignInOutput> = {};
    {
      const _v = _pcDecodeString(u8, offset);
      result.token = _v.value;
      offset += _v.bytesRead;
    }
    {
      const _v = _pcDecodeString(u8, offset);
      result.role = _v.value;
      offset += _v.bytesRead;
    }
    return { ok: true, result: result as SignInOutput };
  },
};

export const signOutCodec: RkyvV2Codec<SignOutInput, SignOutOutput> = {
  commandId: 2,

  encode(args: SignOutInput): ArrayBuffer {
    // [cmd_id: u16 LE][postcard(SignOutInput)]
    const parts: Uint8Array[] = [];
    const cmdId = new Uint8Array(2);
    new DataView(cmdId.buffer).setUint16(0, 2, true);
    parts.push(cmdId);
    parts.push(_pcEncodeString(args.token));
    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;
  },

  encodeInto(args: SignOutInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.token; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: SignOutOutput; error?: RustraError } {
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
    const result: Partial<SignOutOutput> = {};
    {
      result.signedOut = u8[offset] === 1;
      offset += 1;
    }
    return { ok: true, result: result as SignOutOutput };
  },
};
