/**
 * TypeScript 코드 생성 유틸리티입니다.
 *
 * JSON Schema를 TypeScript 타입 표현식으로 변환하고
 * 명령 이름을 lowerCamelCase 함수 이름으로 변환합니다.
 */

import type { JsonSchema } from './schema.js';

/** `$ref` 문자열에서 타입 이름을 추출합니다. `#/definitions/Foo` → `Foo` */
export function resolveRef(ref: string): string {
  if (ref.startsWith('#/definitions/')) return ref.slice('#/definitions/'.length);
  if (ref.startsWith('#/$defs/')) return ref.slice('#/$defs/'.length);
  return ref;
}

/**
 * JSON Schema를 TypeScript 타입 표현식 문자열로 변환합니다.
 *
 * `$ref`, `anyOf`, `object`, `array`, 원시 타입 등을 재귀적으로 처리합니다.
 */
export function tsTypeFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (schema.$ref) return resolveRef(schema.$ref);

  if (schema.anyOf) {
    return schema.anyOf.map((s) => tsTypeFromSchema(s, definitions)).join(' | ');
  }

  const type = schema.type;

  if (typeof type === 'string') {
    switch (type) {
      case 'object':
        if (!schema.properties && schema.additionalProperties) {
          const valueType = tsTypeFromSchema(schema.additionalProperties, definitions);
          return `Record<string, ${valueType}>`;
        }
        return tsObjectFromSchema(schema, definitions);
      case 'integer':
      case 'number':
        return 'number';
      case 'string': {
        if (schema.enum && schema.enum.length > 0) {
          return schema.enum.map((v) => `'${v}'`).join(' | ');
        }
        return 'string';
      }
      case 'boolean':
        return 'boolean';
      case 'array': {
        const itemSchema = schema.items;
        const itemType = itemSchema
          ? tsTypeFromSchema(Array.isArray(itemSchema) ? itemSchema[0] : itemSchema, definitions)
          : 'unknown';
        return `${itemType}[]`;
      }
      case 'null':
        return 'null';
      default:
        return 'unknown';
    }
  }

  if (Array.isArray(type)) {
    const parts = type
      .map((t) => {
        switch (t) {
          case 'integer':
          case 'number':
            return 'number';
          case 'string':
            return 'string';
          case 'boolean':
            return 'boolean';
          case 'null':
            return 'null';
          case 'object':
            return tsObjectFromSchema(schema, definitions);
          case 'array':
            return schema.items
              ? `${tsTypeFromSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items, definitions)}[]`
              : 'unknown[]';
          default:
            return 'unknown';
        }
      })
      .filter((v, i, a) => a.indexOf(v) === i);
    return parts.join(' | ');
  }

  return 'unknown';
}

/**
 * JSON Schema object를 TypeScript 객체 타입 리터럴로 변환합니다.
 *
 * `properties`의 각 필드를 `name: type;` 형식으로 생성하며,
 * `required`에 없는 필드는 `?` 선택적 필드로 표시합니다.
 */
export function tsObjectFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties;

  if (!properties) return 'Record<string, unknown>';

  const fields = Object.entries(properties)
    .map(([name, propSchema]) => {
      const optional = required.has(name) ? '' : '?';
      return `  ${name}${optional}: ${tsTypeFromSchema(propSchema, definitions)};`;
    })
    .join('\n');

  return `{\n${fields}\n}`;
}

/**
 * 스키마에서 `definitions` 객체를 추출하여 `out`에 병합합니다.
 */
export function collectDefinitions(schema: JsonSchema, out: Record<string, JsonSchema>): void {
  if (schema.definitions) {
    for (const [key, value] of Object.entries(schema.definitions)) {
      out[key] = value;
    }
  }
}

/** 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다. */
export function commandFunctionName(name: string): string {
  let output = '';
  let uppercaseNext = false;

  for (const char of name) {
    if (isAsciiAlphanumeric(char)) {
      if (output.length === 0) {
        output += char.toLowerCase();
      } else if (uppercaseNext) {
        output += char.toUpperCase();
        uppercaseNext = false;
      } else {
        output += char;
      }
    } else {
      uppercaseNext = true;
    }
  }

  return output.length > 0 ? output : 'command';
}

function isAsciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ── Postcard wire format utilities (emitted into generated code) ──────────

/**
 * Returns the shared postcard helper source code that should be emitted once
 * at the top of the generated `rkyv-codecs.ts` file.
 *
 * These functions implement the postcard wire format:
 * - Unsigned LEB128 varint for lengths and counts
 * - Zigzag + LEB128 varint for signed integers
 * - Fixed-width little-endian for f64/f32
 * - 1-byte for bool
 * - Varint-prefixed UTF-8 for strings
 */
export function postcardHelperSource(): string {
  return `// ── postcard wire format helpers ─────────────────────────────

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

`;
}
