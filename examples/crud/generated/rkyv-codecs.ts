// ── postcard wire format helpers ─────────────────────────────

// encodeInto 의 f32/f64 기록용 모듈 스크립트 버퍼 — 호출당 할당 없이 재사용.
const _dvScratchBuf = new ArrayBuffer(8);
const _dvScratch = new DataView(_dvScratchBuf);
const _dvScratchU8 = new Uint8Array(_dvScratchBuf);

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

const _pcI64Min = -(2n ** 63n);
const _pcI64Max = 2n ** 63n - 1n;

function _pcEncodeVarint64(v: number | bigint): Uint8Array {
  // 64-bit LEB128. safe number 는 number 산술 fast path(_pcEncodeVarint 와
  // 동일 출력), 그 밖(bigint, 2^53 초과)은 BigInt 산술 — 정밀도 손실 없음.
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
    return _pcEncodeVarint(v);
  }
  let value = BigInt(v);
  if (value < 0n) throw new Error('varint must be non-negative: ' + value.toString());
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
  // 앞 7바이트(≤49비트, 2^53 이하)는 Number 누적 — 대부분의 varint 가 끝나는
  // 구간이며 BigInt 할당이 전혀 없다. 8바이트 진입 시 BigInt 로 이월해 u64
  // 전체를 무손실 누적한다. 반환 계약은 toJsInteger 선례: safe 정수면 number,
  // 넘으면 bigint. 10바이트째 마지막 바이트는 0x00/0x01 만 허용한다(Rust
  // postcard max_of_last_byte = 2^(64%7)−1 = 1) — 64비트 초과 인코딩은
  // 무음 왜곡 대신 throw.
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
      if (bytesRead === 8) big = BigInt(num); // 49비트 누적분을 BigInt 로 이월
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
  // i64 zigzag: (n << 1) ^ (n >> 63). bigint 산술로 i64 전체 범위를 커버하며,
  // 범위 밖 입력은 validateInteger 선례대로 throw 한다(무음 왜곡 금지 —
  // 음수 varint throw 와 일관).
  const n = BigInt(v);
  if (n < _pcI64Min || n > _pcI64Max) {
    throw new Error('zigzag64 input outside i64 range: ' + n.toString());
  }
  const encoded = (n << 1n) ^ (n >> 63n);
  return _pcEncodeVarint64(encoded);
}

function _pcDecodeZigzag64(v: number | bigint): number | bigint {
  const n = BigInt(v);
  const decoded = (n >> 1n) ^ -(n & 1n);
  const asNumber = Number(decoded);
  return Number.isSafeInteger(asNumber) ? asNumber : decoded;
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

import { createComplexCodec } from '@rustra/types';
import type { RkyvV2Codec, RustraError, ComplexSchema } from '@rustra/types';
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
    out[w++] = 1; out[w++] = 0;
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
        const _v = _pcDecodeVarint64(u8, offset);
        _obj.value = _pcDecodeZigzag64(_v.value);
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

  encodeInto(args: DeleteItemInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.id; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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

  encodeInto(args: GetItemInput, reuse?: Uint8Array): Uint8Array {
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
    { const _s = args.id; const _u = _utf8Encode(_s); ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }
    return out.subarray(0, w);
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
    // Decode postcard from offset 8
    let offset = 8;
    const result: Partial<GetItemOutput> = {};
    {
      const _tag = u8[offset];
      offset += 1;
      if (_tag === 0) {
        result.item = null;
      } else {
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
            const _v = _pcDecodeVarint64(u8, offset);
            _obj.value = _pcDecodeZigzag64(_v.value);
            offset += _v.bytesRead;
          }
          result.item = _obj;
        }
      }
    }
    return { ok: true, result: result as GetItemOutput };
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
    {
      const _opt = args.minValue;
      if (_opt === null || _opt === undefined) {
        parts.push(new Uint8Array([0]));
      } else {
        parts.push(new Uint8Array([1]));
        parts.push(_pcEncodeZigzag64(_opt));
      }
    }
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
    // Decode postcard from offset 8
    let offset = 8;
    const result: Partial<ListItemsOutput> = {};
    {
      const _len = _pcDecodeVarint(u8, offset);
      offset += _len.bytesRead;
      const _arr: Item[] = new Array(_len.value);
      for (let _i = 0; _i < _len.value; _i++) {
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
          const _v = _pcDecodeVarint64(u8, offset);
          _obj.value = _pcDecodeZigzag64(_v.value);
          offset += _v.bytesRead;
        }
        _arr[_i] = _obj;
      }
      result.items = _arr;
    }
    return { ok: true, result: result as ListItemsOutput };
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
    {
      const _opt = args.name;
      if (_opt === null || _opt === undefined) {
        parts.push(new Uint8Array([0]));
      } else {
        parts.push(new Uint8Array([1]));
        parts.push(_pcEncodeString(_opt));
      }
    }
    {
      const _opt = args.value;
      if (_opt === null || _opt === undefined) {
        parts.push(new Uint8Array([0]));
      } else {
        parts.push(new Uint8Array([1]));
        parts.push(_pcEncodeZigzag64(_opt));
      }
    }
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
    // Decode postcard from offset 8
    let offset = 8;
    const result: Partial<UpdateItemOutput> = {};
    {
      const _tag = u8[offset];
      offset += 1;
      if (_tag === 0) {
        result.item = null;
      } else {
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
            const _v = _pcDecodeVarint64(u8, offset);
            _obj.value = _pcDecodeZigzag64(_v.value);
            offset += _v.bytesRead;
          }
          result.item = _obj;
        }
      }
    }
    return { ok: true, result: result as UpdateItemOutput };
  },
};
