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
 * JSDoc 주석 탈출 — description 등 자유 문자열이 `*\/`(닫는 주석)으로
 * 주석을 깨고 코드 위치로 나오는 것을 막는다(공급망 주입 방어).
 * description 은 정당하게 자유 문자열이므로 파싱 거부가 아니라 방출
 * 시점 이스케이프로 방어한다.
 */
export function escapeJsDoc(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/**
 * 작은따옴표 문자열 리터럴 탈출 — enum/const 값 등 자유 문자열이 `'` 나
 * 개행으로 리터럴을 깨고 나오는 것을 막는다(공급망 주입 방어).
 */
export function escapeStringLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
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

  // allOf → intersection `A & B` (schemars 미출력이지만 JSON Schema 표준 결합).
  if (schema.allOf) {
    return schema.allOf.map((s) => tsTypeFromSchema(s, definitions)).join(' & ');
  }

  if (schema.anyOf) {
    return schema.anyOf.map((s) => tsTypeFromSchema(s, definitions)).join(' | ');
  }

  if (schema.oneOf) {
    return schema.oneOf.map((s) => tsTypeFromSchema(s, definitions)).join(' | ');
  }

  const type = schema.type;

  if (typeof type === 'string') {
    switch (type) {
      case 'object':
        if (
          !schema.properties &&
          schema.additionalProperties &&
          typeof schema.additionalProperties === 'object'
        ) {
          const valueType = tsTypeFromSchema(schema.additionalProperties, definitions);
          return `Record<string, ${valueType}>`;
        }
        return tsObjectFromSchema(schema, definitions);
      case 'integer': {
        // integer enum → `1 | 2 | 3` 리터럴 union (Rust codegen.ts_type_from_schema와 일치).
        if (schema.enum && schema.enum.length > 0) {
          return schema.enum.map((v) => String(v)).join(' | ');
        }
        if (schema.format === 'int64' || schema.format === 'uint64') return 'number | bigint';
        return 'number';
      }
      case 'number':
        return 'number';
      case 'string': {
        if (schema.enum && schema.enum.length > 0) {
          return schema.enum.map((v) => `'${escapeStringLiteral(String(v))}'`).join(' | ');
        }
        return 'string';
      }
      case 'boolean':
        return 'boolean';
      case 'array': {
        const itemSchema = schema.items;
        if (Array.isArray(itemSchema)) {
          // Tuple: items가 스키마 배열이면 [t1, t2, ...] 튜플로 매핑 (Rust codegen과 일치).
          const elementTypes = itemSchema.map((s) => tsTypeFromSchema(s, definitions));
          return `[${elementTypes.join(', ')}]`;
        }
        // Vec<u8>는 JSON 어댑터에서 number[], JS 코덱에서 Uint8Array,
        // JSI 전용 경로에서 ArrayBuffer로 돌아올 수 있다.
        if (itemSchema?.type === 'integer' && itemSchema.format === 'uint8') {
          return 'Uint8Array | ArrayBuffer | number[]';
        }
        const itemType = itemSchema ? tsTypeFromSchema(itemSchema, definitions) : 'unknown';
        // `uniqueItems: true` (Rust `BTreeSet`/`HashSet`)는 `Set<T>`로 매핑.
        // Rust codegen(ts_type_from_schema)과 동일 규칙.
        if (schema.uniqueItems) return `Set<${itemType}>`;
        return itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`;
      }
      case 'null':
        return 'null';
      default:
        return 'unknown';
    }
  }

  if (Array.isArray(type)) {
    const parts = new Set<string>();
    for (const member of type) {
      switch (member) {
        case 'integer':
          parts.add(
            schema.format === 'int64' || schema.format === 'uint64' ? 'number | bigint' : 'number',
          );
          break;
        case 'number':
          parts.add('number');
          break;
        case 'string':
          parts.add('string');
          break;
        case 'boolean':
          parts.add('boolean');
          break;
        case 'null':
          parts.add('null');
          break;
        case 'object':
          parts.add(tsObjectFromSchema(schema, definitions));
          break;
        case 'array': {
          const items = schema.items;
          if (Array.isArray(items)) {
            const elementTypes = items.map((s) => tsTypeFromSchema(s, definitions));
            parts.add(`[${elementTypes.join(', ')}]`);
          } else {
            const itemType = items ? tsTypeFromSchema(items, definitions) : 'unknown';
            parts.add(itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`);
          }
          break;
        }
        default:
          parts.add('unknown');
      }
    }
    return [...parts].join(' | ');
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
      // `const` 프로퍼티(판별 유니온 태그 등)는 리터럴 타입으로 매핑 —
      // `#[serde(tag = "type")]` variant 가 schemars 에서 { type: { const: "A" } } 로
      // 내보내지므로 `{ type: 'A' }` 판별 필드가 만들어진다.
      const type = constLiteral(propSchema) ?? tsTypeFromSchema(propSchema, definitions);
      let fieldStr = '';
      if (typeof propSchema.description === 'string') {
        fieldStr += `  /** ${escapeJsDoc(propSchema.description).replace(/\n/g, ' ')} */\n`;
      }
      fieldStr += `  ${name}${optional}: ${type};`;
      return fieldStr;
    })
    .join('\n');

  return `{\n${fields}\n}`;
}

/** `const` 키를 갖는 스키마의 리터럴 표현 — string/number/boolean만 지원. */
function constLiteral(schema: JsonSchema): string | null {
  if (schema.const === undefined) return null;
  if (typeof schema.const === 'string') return `'${escapeStringLiteral(schema.const)}'`;
  if (typeof schema.const === 'number' || typeof schema.const === 'boolean') {
    return String(schema.const);
  }
  return null;
}

/**
 * 스키마에서 `definitions` 객체를 추출하여 `out`에 병합합니다.
 *
 * 최상위 `definitions`뿐 아니라 중첩 위치(command 스키마 내부, 다른 definition
 * 내부)의 `definitions`도 재귀적으로 수집한다 — schemars는 중첩 타입의 스키마를
 * 루트 `definitions`에 두지만, 커스텀/기여 스키마에서 내부 배치가 나올 수 있고
 * 재귀 타입(self-`$ref`) 정의를 누락하면 `types.ts`에 미정의 타입 참조가 남는다.
 */
export function collectDefinitions(schema: JsonSchema, out: Record<string, JsonSchema>): void {
  collectDefinitionsInner(schema, out, new Set());
}

function collectDefinitionsInner(
  schema: JsonSchema,
  out: Record<string, JsonSchema>,
  visited: Set<JsonSchema>,
): void {
  if (visited.has(schema)) return;
  visited.add(schema);

  if (schema.definitions) {
    for (const [key, value] of Object.entries(schema.definitions)) {
      if (!out[key]) out[key] = value;
      collectDefinitionsInner(value, out, visited);
    }
  }

  // 중첩 위치의 definitions / $ref 대상 정의도 따라간다.
  const subs: JsonSchema[] = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...(schema.prefixItems ?? []),
    ...(schema.properties ? Object.values(schema.properties) : []),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    subs.push(schema.additionalProperties);
  }
  for (const sub of subs) {
    collectDefinitionsInner(sub, out, visited);
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

`;
}
