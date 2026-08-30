// ── T2-2: 스키마→postcard 코덱 인터프리터 ────────────────────
//
// live_schema 의 inputSchema/outputSchema(JSON Schema 노드)로부터 런타임에
// RkyvV2Codec 을 생성한다 — 코드젠(@rustra/cli)이 하는 일을 스키마 인터프리터로
// 재현해, **동적 명령**(register/replace)도 postcard fast-path 를 쓸 수 있게 한다.
//
// 와이어 패리티 계약:
//   - 이 모듈의 헬퍼(_scEncode*/_scDecode*)는 코드젠이 생성 파일에 인라인하는
//     `_pc*` 헬퍼(postcardPrimitive/Wide/Text/FloatSource)와 동일 알고리즘이다.
//     중복 구현이 아니라 단일 알고리즘의 두 번째 서빙 지점이며, 바이트 동일성은
//     PINNED hex(wire_fixtures.rs 와 공유) 교차 테스트로 고정한다.
//   - 필드 판정은 @rustra/cli classifyPostcardField 의 미러다(Rust 측
//     js_postcard_codec_supported_with_defs 도 동일 판정). 미러 간 불일치는
//     Tier 3 로 안전하게 실패한다 — 와이어 오염이 없다.
//   - 미지원 노드는 null 을 반환하고, 엔진은 그 명령을 Tier 3(JSON) 로 폴백한다.
//
// 지원 형태: zigzag/uvar(32bit), zigzag64/uvar64, f32/f64, bool, String,
// bytes(Vec<u8>), Vec/set 원시, 원시값 map, tuple(2..), string enum,
// struct(재귀 $ref 포함), Option. 미지원: payload enum(oneOf — Rust 는
// complex 라우트로 승격하므로 JS 인터프리터도 만들지 않는다), 3항 anyOf,
// 혼합 object, uniqueItems string set 등.

import type { ComplexSchema } from './complex-codec-types.js';
import { optionInner } from './complex-codec-schema.js';
import { decodeUtf8, encodeUtf8 } from './utf8.js';
import type { RustraError } from './errors.js';
import type { RkyvV2Codec } from './public.js';

// ── postcard wire helpers (codegen `_pc*` 미러) ─────────────

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function encVarint(n: number): Uint8Array {
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

function decVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let multiplier = 1;
  let bytesRead = 0;
  while (true) {
    const b = buf[offset + bytesRead];
    if (b === undefined) throw new Error('varint out of bounds');
    value += (b & 0x7f) * multiplier;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    multiplier *= 128;
    if (bytesRead > 10) throw new Error('varint too long');
  }
  return { value, bytesRead };
}

function encVarint64(v: number | bigint): Uint8Array {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return encVarint(v);
  let value = BigInt(v);
  if (value < 0n) throw new Error('varint must be non-negative: ' + value.toString());
  if (value > U64_MAX) throw new Error('varint exceeds u64 range: ' + value.toString());
  const bytes: number[] = [];
  do {
    let next = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) next |= 0x80;
    bytes.push(next);
  } while (value !== 0n);
  return new Uint8Array(bytes);
}

function decVarint64(
  buf: Uint8Array,
  offset: number,
): { value: number | bigint; bytesRead: number } {
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

function zigzagEncode(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}
function zigzagDecode(n: number): number {
  const negative = n % 2 === 1;
  const magnitude = Math.floor(n / 2);
  return negative ? -magnitude - 1 : magnitude;
}
function encZigzagVarint(n: number): Uint8Array {
  return encVarint(zigzagEncode(n));
}
function decZigzagVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  const { value, bytesRead } = decVarint(buf, offset);
  return { value: zigzagDecode(value), bytesRead };
}
function encZigzag64(v: number | bigint): Uint8Array {
  const n = BigInt(v);
  if (n < I64_MIN || n > I64_MAX)
    throw new Error('zigzag64 input outside i64 range: ' + n.toString());
  return encVarint64((n << 1n) ^ (n >> 63n));
}
function decZigzag64(v: number | bigint): number | bigint {
  const decoded = (BigInt(v) >> 1n) ^ -(BigInt(v) & 1n);
  const asNumber = Number(decoded);
  return Number.isSafeInteger(asNumber) ? asNumber : decoded;
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
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

function utf8Encode(s: string): Uint8Array {
  return encodeUtf8(s);
}
function utf8Decode(bytes: Uint8Array): string {
  return decodeUtf8(bytes);
}
function encString(s: string): Uint8Array {
  const bytes = utf8Encode(s);
  return concatBytes([encVarint(bytes.length), bytes]);
}
function decString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len = decVarint(buf, offset);
  const start = offset + len.bytesRead;
  const end = start + len.value;
  return {
    value: utf8Decode(buf.slice(start, end)),
    bytesRead: len.bytesRead + len.value,
  };
}

function encF64(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, true);
  return new Uint8Array(buf);
}
function decF64(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  return {
    value: new DataView(buf.buffer, buf.byteOffset + offset, 8).getFloat64(0, true),
    bytesRead: 8,
  };
}
function encF32(n: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, n, true);
  return new Uint8Array(buf);
}
function decF32(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  return {
    value: new DataView(buf.buffer, buf.byteOffset + offset, 4).getFloat32(0, true),
    bytesRead: 4,
  };
}

// ── 스키마 노드 분류 (classifyPostcardField 미러) ────────────

type Encoder = (value: unknown) => Uint8Array;
type Decoder = (buf: Uint8Array, offset: number) => { value: unknown; bytesRead: number };

type SchemaNode = {
  encode: Encoder;
  decode: Decoder;
};

// TODO(json-wire): resolveRef 의 접두사 판정('#/definitions/' 가 아닌 슬래시
// 경로는 null 로 폴백)은 postcard 지원 판정의 일부라 refName 로 바꾸지 않는다
// — json-wire 쪽 공용 export 가 준비되면 이동한다.
function resolveRef(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
): ComplexSchema | null {
  const ref = schema.$ref;
  if (!ref) return schema;
  const name = ref.startsWith('#/definitions/') ? ref.slice('#/definitions/'.length) : ref;
  return definitions[name] ?? null;
}

/**
 * Option<T> 언래핑 — `complex-codec-schema.optionInner` 를 재사용하되 postcard
 * 판정(anyOf 조건)은 그대로 유지한다: anyOf 멤버 중 null 타입이 하나 있고,
 * 나머지가 중첩 anyOf 가 아닌 단일 non-null 일 때만 Option 으로 인정한다.
 * 와이어는 type-array 분기(공통)와 anyOf 분기(로컬)가 서로 다른 판정을 낸다.
 */
function unwrapOption(schema: ComplexSchema): ComplexSchema | null {
  if (Array.isArray(schema.type)) return optionInner(schema);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const nonNull = schema.anyOf.filter((item) => item.type !== 'null' && !('anyOf' in item));
    return nonNull.length === 1 && schema.anyOf.some((item) => item.type === 'null')
      ? nonNull[0]
      : null;
  }
  return null;
}

function isPlainMap(schema: ComplexSchema): boolean {
  return (
    schema.type === 'object' &&
    !!schema.additionalProperties &&
    typeof schema.additionalProperties === 'object' &&
    !schema.properties
  );
}

/** 스키마 노드를 encode/decode 클로저로 컴파일한다. 미지원이면 null. */
function compileNode(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  depth: number,
): SchemaNode | null {
  if (depth > 8) return null;

  // tuple newtype (schemars: single-entry allOf + $ref) — 내부로 투명하게.
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return compileNode(schema.allOf[0], definitions, depth + 1);
  }

  // string enum — variant index varint (선언순).
  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const variants = schema.enum.filter((v): v is string => typeof v === 'string');
    if (variants.length !== schema.enum.length) return null;
    return {
      encode: (value) => {
        const idx = variants.indexOf(value as string);
        if (idx < 0) throw new Error('invalid enum value: ' + String(value));
        return encVarint(idx);
      },
      decode: (buf, offset) => {
        const v = decVarint(buf, offset);
        const variant = variants[v.value];
        if (variant === undefined) throw new Error('enum index out of range: ' + v.value);
        return { value: variant, bytesRead: v.bytesRead };
      },
    };
  }

  // $ref 해결.
  if (schema.$ref) {
    const resolved = resolveRef(schema, definitions);
    if (!resolved) return null;
    if (resolved.type === 'object' && resolved.properties && !resolved.additionalProperties) {
      return compileStruct(resolved, definitions, depth);
    }
    return compileNode(resolved, definitions, depth + 1);
  }

  if (schema.type === 'boolean') {
    return {
      encode: (v) => new Uint8Array([v ? 1 : 0]),
      decode: (buf, offset) => ({ value: buf[offset] === 1, bytesRead: 1 }),
    };
  }

  if (schema.type === 'integer') {
    if (schema.format === 'uint64') {
      return {
        encode: (v) => encVarint64(v as number | bigint),
        decode: (buf, offset) => {
          const v = decVarint64(buf, offset);
          return { value: v.value, bytesRead: v.bytesRead };
        },
      };
    }
    if (schema.format === 'int64') {
      return {
        encode: (v) => encZigzag64(v as number | bigint),
        decode: (buf, offset) => {
          const v = decVarint64(buf, offset);
          return { value: decZigzag64(v.value), bytesRead: v.bytesRead };
        },
      };
    }
    const unsigned = ['uint8', 'uint16', 'uint32'].includes(schema.format ?? '');
    if (unsigned) {
      return {
        encode: (v) => encVarint(v as number),
        decode: (buf, offset) => {
          const v = decVarint(buf, offset);
          return { value: v.value, bytesRead: v.bytesRead };
        },
      };
    }
    return {
      encode: (v) => encZigzagVarint(v as number),
      decode: (buf, offset) => {
        const v = decZigzagVarint(buf, offset);
        return { value: v.value, bytesRead: v.bytesRead };
      },
    };
  }

  if (schema.type === 'number') {
    return schema.format === 'float'
      ? {
          encode: (v) => encF32(v as number),
          decode: (buf, offset) => {
            const v = decF32(buf, offset);
            return { value: v.value, bytesRead: v.bytesRead };
          },
        }
      : {
          encode: (v) => encF64(v as number),
          decode: (buf, offset) => {
            const v = decF64(buf, offset);
            return { value: v.value, bytesRead: v.bytesRead };
          },
        };
  }

  if (schema.type === 'string') {
    return {
      encode: (v) => encString(v as string),
      decode: (buf, offset) => {
        const v = decString(buf, offset);
        return { value: v.value, bytesRead: v.bytesRead };
      },
    };
  }

  // Option<T> — type:["T","null"] 또는 anyOf:[T, null].
  const optionInner = unwrapOption(schema);
  if (optionInner) {
    const inner = compileNode(optionInner, definitions, depth + 1);
    if (!inner) return null;
    return {
      encode: (v) =>
        v === null || v === undefined
          ? new Uint8Array([0])
          : concatBytes([new Uint8Array([1]), inner.encode(v)]),
      decode: (buf, offset) => {
        const tag = buf[offset];
        if (tag === undefined) throw new Error('option tag out of bounds');
        if (tag === 0) return { value: null, bytesRead: 1 };
        const v = inner.decode(buf, offset + 1);
        return { value: v.value, bytesRead: 1 + v.bytesRead };
      },
    };
  }

  // 배열 — tuple(items 배열) 우선, 그다음 단일 items.
  if (schema.type === 'array' && schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      const minItems = schema.minItems as number | undefined;
      const maxItems = schema.maxItems as number | undefined;
      if (minItems === maxItems && minItems !== undefined && minItems > 0) {
        const items = schema.items.map((item) => compileNode(item, definitions, depth + 1));
        if (items.some((n) => n === null)) return null;
        const nodes = items as SchemaNode[];
        return {
          encode: (v) => {
            const arr = v as unknown[];
            return concatBytes(arr.map((el, i) => nodes[i].encode(el)));
          },
          decode: (buf, offset) => {
            let bytesRead = 0;
            const out: unknown[] = [];
            for (const node of nodes) {
              const v = node.decode(buf, offset + bytesRead);
              out.push(v.value);
              bytesRead += v.bytesRead;
            }
            return { value: out, bytesRead };
          },
        };
      }
      return null;
    }
    const items = schema.items as ComplexSchema;
    const uniqueItems = schema.uniqueItems === true;
    // bytes 특례 — Vec<u8> 은 len + raw.
    if (!uniqueItems && items.type === 'integer' && items.format === 'uint8') {
      return {
        encode: (v) => {
          const u = v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
          return concatBytes([encVarint(u.length), u]);
        },
        decode: (buf, offset) => {
          const len = decVarint(buf, offset);
          const start = offset + len.bytesRead;
          return {
            value: buf.slice(start, start + len.value),
            bytesRead: len.bytesRead + len.value,
          };
        },
      };
    }
    const element = compileNode(items, definitions, depth + 1);
    if (!element) return null;
    if (uniqueItems) {
      return {
        encode: (v) => {
          const arr = [...(v as Iterable<unknown>)];
          return concatBytes([encVarint(arr.length), ...arr.map((el) => element.encode(el))]);
        },
        decode: (buf, offset) => {
          const len = decVarint(buf, offset);
          let cursor = offset + len.bytesRead;
          const values: unknown[] = [];
          for (let i = 0; i < len.value; i++) {
            const v = element.decode(buf, cursor);
            values.push(v.value);
            cursor += v.bytesRead;
          }
          return { value: new Set(values), bytesRead: cursor - offset };
        },
      };
    }
    return {
      encode: (v) => {
        const arr = v as unknown[];
        return concatBytes([encVarint(arr.length), ...arr.map((el) => element.encode(el))]);
      },
      decode: (buf, offset) => {
        const len = decVarint(buf, offset);
        let cursor = offset + len.bytesRead;
        const values: unknown[] = [];
        for (let i = 0; i < len.value; i++) {
          const v = element.decode(buf, cursor);
          values.push(v.value);
          cursor += v.bytesRead;
        }
        return { value: values, bytesRead: cursor - offset };
      },
    };
  }

  // 원시값 map — additionalProperties (properties 없음).
  if (isPlainMap(schema)) {
    const valueNode = compileNode(
      schema.additionalProperties as ComplexSchema,
      definitions,
      depth + 1,
    );
    if (!valueNode) return null;
    return {
      encode: (v) => {
        const map = v as Record<string, unknown>;
        const keys = Object.keys(map).sort();
        return concatBytes([
          encVarint(keys.length),
          ...keys.flatMap((k) => [encString(k), valueNode.encode(map[k])]),
        ]);
      },
      decode: (buf, offset) => {
        const len = decVarint(buf, offset);
        let cursor = offset + len.bytesRead;
        const map: Record<string, unknown> = {};
        for (let i = 0; i < len.value; i++) {
          const k = decString(buf, cursor);
          cursor += k.bytesRead;
          const v = valueNode.decode(buf, cursor);
          cursor += v.bytesRead;
          map[k.value] = v.value;
        }
        return { value: map, bytesRead: cursor - offset };
      },
    };
  }

  // struct — properties 선언순(postcard 필드순).
  if (schema.type === 'object' && schema.properties && !schema.additionalProperties) {
    return compileStruct(schema, definitions, depth);
  }

  return null;
}

function compileStruct(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  depth: number,
): SchemaNode | null {
  const names = Object.keys(schema.properties ?? {});
  const nodes: SchemaNode[] = [];
  for (const name of names) {
    const node = compileNode(
      (schema.properties as Record<string, ComplexSchema>)[name],
      definitions,
      depth + 1,
    );
    if (!node) return null;
    nodes.push(node);
  }
  return {
    encode: (v) => {
      const obj = v as Record<string, unknown>;
      return concatBytes(nodes.map((n, i) => n.encode(obj[names[i]])));
    },
    decode: (buf, offset) => {
      let cursor = offset;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < names.length; i++) {
        const v = nodes[i].decode(buf, cursor);
        cursor += v.bytesRead;
        obj[names[i]] = v.value;
      }
      return { value: obj, bytesRead: cursor - offset };
    },
  };
}

// ── RkyvV2Codec 조립 ────────────────────────────────────────

function decodeErrorFrame(u8: Uint8Array, view: DataView): { ok: false; error: RustraError } {
  const errLen = view.getUint16(8, true);
  let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
  if (errLen > 0) {
    // postcard({ code: String, message: String })
    const c = decString(u8, 10);
    const m = decString(u8, 10 + c.bytesRead);
    err = { code: c.value, message: m.value };
  }
  return { ok: false, error: err };
}

/**
 * live_schema 명령 엔트리로부터 postcard 코덱을 생성한다.
 * 입력/출력 스키마 중 하나라도 postcard 미지원 형태면 null — 호출자(엔진)는
 * 그 명령을 Tier 3(JSON-in-binary)로 폴백한다.
 */
export function createSchemaPostcardCodec(
  commandId: number,
  inputSchema: ComplexSchema,
  outputSchema: ComplexSchema,
  definitions: Record<string, ComplexSchema> = {},
): RkyvV2Codec<unknown, unknown> | null {
  const input = compileNode(inputSchema, definitions, 0);
  if (!input) return null;
  const output = compileNode(outputSchema, definitions, 0);
  if (!output) return null;
  return {
    commandId,
    encode(args: unknown): ArrayBuffer {
      // [cmd_id: u16 LE][postcard(Input)]
      const cmdId = new Uint8Array(2);
      new DataView(cmdId.buffer).setUint16(0, commandId, true);
      return concatBytes([cmdId, input.encode(args)]).buffer as ArrayBuffer;
    },
    decode(buf: ArrayBuffer | ArrayBufferView): {
      ok: boolean;
      result?: unknown;
      error?: RustraError;
    } {
      const view =
        buf instanceof ArrayBuffer
          ? new DataView(buf)
          : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const u8 =
        buf instanceof ArrayBuffer
          ? new Uint8Array(buf)
          : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if (view.byteLength < 8) {
        return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
      }
      if (u8[0] !== 1) return decodeErrorFrame(u8, view);
      // postcard output at offset 8
      try {
        const v = output.decode(u8, 8);
        return { ok: true, result: v.value };
      } catch {
        return {
          ok: false,
          error: { code: 'invoke.failed', message: 'response postcard decode failed' },
        };
      }
    },
  };
}
