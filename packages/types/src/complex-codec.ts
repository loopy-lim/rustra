import type { RkyvV2Codec, RustraError } from './index.js';

export type ComplexSchema = {
  type?: string | string[];
  properties?: Record<string, ComplexSchema>;
  required?: string[];
  items?: ComplexSchema | ComplexSchema[];
  additionalProperties?: ComplexSchema | boolean;
  uniqueItems?: boolean;
  $ref?: string;
  anyOf?: ComplexSchema[];
  oneOf?: ComplexSchema[];
  allOf?: ComplexSchema[];
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  /** Explicit stable keys for oneOf variants, in schema declaration order. */
  'x-rustra-variant-order'?: string[];
  format?: string;
  [key: string]: unknown;
};

export type ComplexCodecOptions = {
  commandId: number;
  inputSchema: ComplexSchema;
  outputSchema: ComplexSchema;
  definitions?: Record<string, ComplexSchema>;
  maxDepth?: number;
  maxPayloadBytes?: number;
  maxCollectionLength?: number;
};

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_COLLECTION_LENGTH = 100_000;

class ComplexCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplexCodecError';
  }
}

function utf8Encode(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const bytes = unescape(encodeURIComponent(value));
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) output[i] = bytes.charCodeAt(i);
  return output;
}

function utf8Decode(value: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined')
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(binary));
  } catch {
    throw new ComplexCodecError('invalid UTF-8 string');
  }
}

function isUnsigned(schema: ComplexSchema): boolean {
  return typeof schema.format === 'string' && schema.format.startsWith('uint');
}

function toInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new ComplexCodecError('integer must be a safe number or bigint');
}

function integerBounds(schema: ComplexSchema): { min: bigint; max: bigint } {
  switch (schema.format) {
    case 'uint8':
      return { min: 0n, max: 0xffn };
    case 'uint16':
      return { min: 0n, max: 0xffffn };
    case 'uint32':
      return { min: 0n, max: 0xffffffffn };
    case 'uint64':
      return { min: 0n, max: 0xffffffffffffffffn };
    case 'int8':
      return { min: -0x80n, max: 0x7fn };
    case 'int16':
      return { min: -0x8000n, max: 0x7fffn };
    case 'int32':
      return { min: -0x80000000n, max: 0x7fffffffn };
    case 'int64':
    default:
      return { min: -0x8000000000000000n, max: 0x7fffffffffffffffn };
  }
}

function validateInteger(value: bigint, schema: ComplexSchema): bigint {
  const { min, max } = integerBounds(schema);
  if (value < min || value > max) {
    throw new ComplexCodecError(`integer is outside ${String(min)}..${String(max)}`);
  }
  return value;
}

function toJsInteger(value: bigint, schema: ComplexSchema): number | bigint {
  validateInteger(value, schema);
  if (schema.format === 'int64' || schema.format === 'uint64') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber))
    throw new ComplexCodecError('decoded integer exceeds JavaScript safe range');
  return asNumber;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const a = utf8Encode(left);
  const b = utf8Encode(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function resolvedSchema(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  depth: number,
): ComplexSchema {
  if (depth > DEFAULT_MAX_DEPTH) throw new ComplexCodecError('schema reference depth exceeded');
  if (schema.$ref) {
    const resolved = definitions[refName(schema.$ref)];
    if (!resolved) throw new ComplexCodecError(`missing schema definition ${schema.$ref}`);
    return resolvedSchema(resolved, definitions, depth + 1);
  }
  if (schema.allOf) {
    if (schema.allOf.length === 1) return resolvedSchema(schema.allOf[0], definitions, depth + 1);
    throw new ComplexCodecError('complex codec does not support multi-entry allOf');
  }
  return schema;
}

function optionInner(schema: ComplexSchema): ComplexSchema | null {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== 'null');
    if (schema.type.length === 2 && nonNull.length === 1) return { ...schema, type: nonNull[0] };
  }
  if (schema.anyOf?.length === 2) {
    const nonNull = schema.anyOf.filter((item) => item.type !== 'null');
    if (nonNull.length === 1) return nonNull[0];
  }
  return null;
}

function readPresence(reader: Reader, label: string): boolean {
  const tag = reader.byte();
  if (tag === 0) return false;
  if (tag === 1) return true;
  throw new ComplexCodecError(`invalid ${label} presence tag`);
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxPayloadBytes: number) {}

  push(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.maxPayloadBytes) {
      throw new ComplexCodecError(`payload exceeds ${this.maxPayloadBytes} bytes`);
    }
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  byte(value: number): void {
    this.push(new Uint8Array([value]));
  }

  varint(value: bigint): void {
    if (value < 0n) throw new ComplexCodecError('varint cannot be negative');
    const bytes: number[] = [];
    do {
      let next = Number(value & 0x7fn);
      value >>= 7n;
      if (value !== 0n) next |= 0x80;
      bytes.push(next);
    } while (value !== 0n);
    this.push(new Uint8Array(bytes));
  }

  zigzag(value: bigint): void {
    this.varint(value >= 0n ? value * 2n : -value * 2n - 1n);
  }

  string(value: string): void {
    const bytes = utf8Encode(value);
    this.varint(BigInt(bytes.length));
    this.push(bytes);
  }

  finish(): ArrayBuffer {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output.buffer;
  }
}

class Reader {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxCollectionLength: number,
  ) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  need(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) {
      throw new ComplexCodecError('truncated complex payload');
    }
  }

  raw(length: number): Uint8Array {
    this.need(length);
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new ComplexCodecError('varint is too long');
  }

  zigzag(): bigint {
    const value = this.varint();
    return (value >> 1n) ^ -(value & 1n);
  }

  length(): number {
    const value = this.varint();
    if (value > BigInt(this.maxCollectionLength) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ComplexCodecError(`collection length exceeds ${this.maxCollectionLength}`);
    }
    return Number(value);
  }

  string(): string {
    return utf8Decode(this.raw(this.length()));
  }
}

type Variant = { schema: ComplexSchema; key: string };

function variantKey(schema: ComplexSchema): string | null {
  if (typeof schema.const === 'string') return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return String(schema.enum[0]);
  const properties = schema.properties;
  if (properties) {
    const discriminator = Object.entries(properties).find(([, value]) => value.const !== undefined);
    if (discriminator) return String(discriminator[1].const);
    const keys = Object.keys(properties);
    if (keys.length === 1) return keys[0];
  }
  return typeof schema.title === 'string' ? schema.title : null;
}

function variants(schema: ComplexSchema): Variant[] {
  const result: Variant[] = [];
  const explicit = schema['x-rustra-variant-order'];
  const choices = schema.oneOf ?? [];
  if (
    explicit &&
    (explicit.length !== choices.length || new Set(explicit).size !== explicit.length)
  ) {
    throw new ComplexCodecError(
      'x-rustra-variant-order must contain unique keys for every variant',
    );
  }
  for (const [index, variant] of choices.entries()) {
    const key = explicit?.[index] ?? variantKey(variant);
    if (key === null)
      throw new ComplexCodecError('enum variants require a stable key or explicit metadata');
    result.push({ schema: variant, key });
  }
  result.sort((left, right) => compareUtf8(left.key, right.key));
  if (new Set(result.map((variant) => variant.key)).size !== result.length) {
    throw new ComplexCodecError('enum variant keys must be unique');
  }
  return result;
}

function discriminator(schema: ComplexSchema): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (value.const !== undefined) return { key, value: value.const };
  }
  return null;
}

function encodeNode(
  writer: Writer,
  rawSchema: ComplexSchema,
  value: unknown,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): void {
  if (depth > maxDepth) throw new ComplexCodecError(`value depth exceeds ${maxDepth}`);
  const schema = resolvedSchema(rawSchema, definitions, depth);
  const inner = optionInner(schema);
  if (inner) {
    if (value === null || value === undefined) {
      writer.byte(0);
    } else {
      writer.byte(1);
      encodeNode(writer, inner, value, definitions, maxDepth, depth + 1, maxCollectionLength);
    }
    return;
  }
  if (schema.oneOf) {
    const choices = variants(schema);
    const selected = choices.findIndex(({ schema: variant }) => matchesVariant(variant, value));
    if (selected < 0) throw new ComplexCodecError('value does not match any enum variant');
    writer.varint(BigInt(selected));
    encodeVariant(
      writer,
      choices[selected].schema,
      value,
      definitions,
      maxDepth,
      depth + 1,
      maxCollectionLength,
    );
    return;
  }
  if (schema.enum) {
    const index = schema.enum.findIndex((candidate) => Object.is(candidate, value));
    if (index < 0) throw new ComplexCodecError('value is not a member of enum');
    writer.varint(BigInt(index));
    return;
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    throw new ComplexCodecError(`value does not match const ${String(schema.const)}`);
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ComplexCodecError('expected boolean');
    writer.byte(value ? 1 : 0);
  } else if (schema.type === 'integer') {
    const integer = validateInteger(toInteger(value), schema);
    if (isUnsigned(schema)) writer.varint(integer);
    else writer.zigzag(integer);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new ComplexCodecError('expected finite number');
    const buffer = new ArrayBuffer(schema.format === 'float' ? 4 : 8);
    const view = new DataView(buffer);
    if (buffer.byteLength === 4) view.setFloat32(0, value, true);
    else view.setFloat64(0, value, true);
    writer.push(new Uint8Array(buffer));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ComplexCodecError('expected string');
    writer.string(value);
  } else if (schema.type === 'null') {
    if (value !== null) throw new ComplexCodecError('expected null');
  } else if (schema.type === 'array') {
    const items = schema.items;
    const values = value instanceof Set ? [...value] : value;
    if (!Array.isArray(values)) throw new ComplexCodecError('expected array or Set');
    if (values.length > maxCollectionLength)
      throw new ComplexCodecError(`collection length exceeds ${maxCollectionLength}`);
    writer.varint(BigInt(values.length));
    if (Array.isArray(items)) {
      if (items.length !== values.length) throw new ComplexCodecError('tuple length mismatch');
      items.forEach((item, index) =>
        encodeNode(
          writer,
          item,
          values[index],
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        ),
      );
    } else if (items) {
      values.forEach((item) =>
        encodeNode(writer, items, item, definitions, maxDepth, depth + 1, maxCollectionLength),
      );
    } else {
      throw new ComplexCodecError('array schema is missing items');
    }
  } else if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && !schema.properties) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ComplexCodecError('expected object map');
      const map = value as Record<string, unknown>;
      const keys = sortedKeys(map);
      if (keys.length > maxCollectionLength)
        throw new ComplexCodecError(`collection length exceeds ${maxCollectionLength}`);
      writer.varint(BigInt(keys.length));
      for (const key of keys) {
        writer.string(key);
        if (!schema.additionalProperties || typeof schema.additionalProperties === 'boolean')
          throw new ComplexCodecError('map schema is missing value type');
        encodeNode(
          writer,
          schema.additionalProperties,
          map[key],
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        );
      }
    } else {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ComplexCodecError('expected object');
      encodeObject(
        writer,
        schema,
        value as Record<string, unknown>,
        definitions,
        maxDepth,
        depth,
        maxCollectionLength,
      );
    }
  } else {
    throw new ComplexCodecError(`unsupported schema type ${String(schema.type)}`);
  }
}

function encodeObject(
  writer: Writer,
  schema: ComplexSchema,
  value: Record<string, unknown>,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
  skipKey?: string,
): void {
  const required = new Set(schema.required ?? []);
  for (const [key, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (key === skipKey) continue;
    const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (!required.has(key)) writer.byte(present ? 1 : 0);
    if (present)
      encodeNode(
        writer,
        fieldSchema,
        value[key],
        definitions,
        maxDepth,
        depth + 1,
        maxCollectionLength,
      );
    else if (required.has(key)) throw new ComplexCodecError(`missing required field ${key}`);
  }
}

function matchesVariant(schema: ComplexSchema, value: unknown): boolean {
  const tag = discriminator(schema);
  if (tag && typeof value === 'object' && value !== null)
    return Object.is((value as Record<string, unknown>)[tag.key], tag.value);
  const properties = schema.properties;
  if (properties && Object.keys(properties).length === 1) {
    const key = Object.keys(properties)[0];
    return (
      typeof value === 'object' &&
      value !== null &&
      Object.prototype.hasOwnProperty.call(value, key)
    );
  }
  if (schema.const !== undefined) return Object.is(schema.const, value);
  if (schema.enum?.length === 1) return Object.is(schema.enum[0], value);
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'object')
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  return false;
}

function encodeVariant(
  writer: Writer,
  schema: ComplexSchema,
  value: unknown,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): void {
  const tag = discriminator(schema);
  if (tag && schema.type === 'object') {
    encodeObject(
      writer,
      schema,
      value as Record<string, unknown>,
      definitions,
      maxDepth,
      depth,
      maxCollectionLength,
      tag.key,
    );
    return;
  }
  const properties = schema.properties;
  if (properties && Object.keys(properties).length === 1) {
    const key = Object.keys(properties)[0];
    encodeNode(
      writer,
      properties[key],
      (value as Record<string, unknown>)[key],
      definitions,
      maxDepth,
      depth,
      maxCollectionLength,
    );
    return;
  }
  if (schema.const !== undefined || schema.enum) return;
  encodeNode(writer, schema, value, definitions, maxDepth, depth, maxCollectionLength);
}

function decodeNode(
  reader: Reader,
  rawSchema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): unknown {
  if (depth > maxDepth) throw new ComplexCodecError(`value depth exceeds ${maxDepth}`);
  const schema = resolvedSchema(rawSchema, definitions, depth);
  const inner = optionInner(schema);
  if (inner)
    return readPresence(reader, 'option')
      ? decodeNode(reader, inner, definitions, maxDepth, depth + 1, maxCollectionLength)
      : null;
  if (schema.oneOf) {
    const choices = variants(schema);
    const index = Number(reader.varint());
    if (!choices[index]) throw new ComplexCodecError('enum variant index out of range');
    return decodeVariant(
      reader,
      choices[index].schema,
      definitions,
      maxDepth,
      depth + 1,
      maxCollectionLength,
    );
  }
  if (schema.enum) {
    const index = Number(reader.varint());
    if (index < 0 || index >= schema.enum.length)
      throw new ComplexCodecError('enum index out of range');
    return schema.enum[index];
  }
  if (schema.type === 'boolean') {
    const value = reader.byte();
    if (value > 1) throw new ComplexCodecError('invalid boolean value');
    return value === 1;
  }
  if (schema.type === 'integer')
    return toJsInteger(isUnsigned(schema) ? reader.varint() : reader.zigzag(), schema);
  if (schema.type === 'number') {
    const bytes = reader.raw(schema.format === 'float' ? 4 : 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return schema.format === 'float' ? view.getFloat32(0, true) : view.getFloat64(0, true);
  }
  if (schema.type === 'string') return reader.string();
  if (schema.type === 'null') return null;
  if (schema.type === 'array') {
    const length = reader.length();
    const items = schema.items;
    if (Array.isArray(items)) {
      if (items.length !== length) throw new ComplexCodecError('tuple length mismatch');
      return items.map((item) =>
        decodeNode(reader, item, definitions, maxDepth, depth + 1, maxCollectionLength),
      );
    }
    if (!items) throw new ComplexCodecError('array schema is missing items');
    const values = Array.from({ length }, () =>
      decodeNode(reader, items, definitions, maxDepth, depth + 1, maxCollectionLength),
    );
    return schema.uniqueItems ? new Set(values) : values;
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && !schema.properties) {
      if (!schema.additionalProperties || typeof schema.additionalProperties === 'boolean')
        throw new ComplexCodecError('map schema is missing value type');
      const result: Record<string, unknown> = {};
      const length = reader.length();
      for (let i = 0; i < length; i += 1) {
        const key = reader.string();
        if (Object.prototype.hasOwnProperty.call(result, key))
          throw new ComplexCodecError(`duplicate map key ${key}`);
        result[key] = decodeNode(
          reader,
          schema.additionalProperties,
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        );
      }
      return result;
    }
    return decodeObject(reader, schema, definitions, maxDepth, depth, maxCollectionLength);
  }
  throw new ComplexCodecError(`unsupported schema type ${String(schema.type)}`);
}

function decodeObject(
  reader: Reader,
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
  skipKey?: string,
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (key === skipKey) continue;
    const present = required.has(key) || readPresence(reader, `optional field ${key}`);
    if (present)
      result[key] = decodeNode(
        reader,
        fieldSchema,
        definitions,
        maxDepth,
        depth + 1,
        maxCollectionLength,
      );
    else if (required.has(key)) throw new ComplexCodecError(`missing required field ${key}`);
  }
  return result;
}

function decodeVariant(
  reader: Reader,
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): unknown {
  const tag = discriminator(schema);
  if (tag && schema.type === 'object') {
    return {
      [tag.key]: tag.value,
      ...decodeObject(reader, schema, definitions, maxDepth, depth, maxCollectionLength, tag.key),
    };
  }
  const properties = schema.properties;
  if (properties && Object.keys(properties).length === 1) {
    const key = Object.keys(properties)[0];
    return {
      [key]: decodeNode(reader, properties[key], definitions, maxDepth, depth, maxCollectionLength),
    };
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  return decodeNode(reader, schema, definitions, maxDepth, depth, maxCollectionLength);
}

function decodeErrorFrame(bytes: Uint8Array): RustraError {
  if (bytes.length < 10)
    return { code: 'invoke.malformed', message: 'complex response error frame is truncated' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const errorLength = view.getUint16(8, true);
  if (errorLength === 0) return { code: 'invoke.failed', message: 'complex invoke failed' };
  try {
    const reader = new Reader(bytes.slice(10, 10 + errorLength), DEFAULT_MAX_COLLECTION_LENGTH);
    const code = reader.string();
    const message = reader.string();
    return { code, message };
  } catch {
    return { code: 'invoke.malformed', message: 'complex response error is malformed' };
  }
}

export function createComplexCodec<I, O>(options: ComplexCodecOptions): RkyvV2Codec<I, O> {
  const definitions = options.definitions ?? {};
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxCollectionLength = options.maxCollectionLength ?? DEFAULT_MAX_COLLECTION_LENGTH;
  if (
    !Number.isSafeInteger(options.commandId) ||
    options.commandId < 0 ||
    options.commandId > 0xffff
  ) {
    throw new ComplexCodecError('command id must fit u16');
  }

  const encode = (args: I): ArrayBuffer => {
    const writer = new Writer(maxPayloadBytes);
    writer.byte(options.commandId & 0xff);
    writer.byte((options.commandId >> 8) & 0xff);
    encodeNode(writer, options.inputSchema, args, definitions, maxDepth, 0, maxCollectionLength);
    return writer.finish();
  };

  return {
    commandId: options.commandId,
    encode,
    encodeInto(args, reuse) {
      const encoded = new Uint8Array(encode(args));
      if (reuse && reuse.length >= encoded.length) {
        reuse.set(encoded);
        return reuse.subarray(0, encoded.length);
      }
      return encoded;
    },
    decode(buffer) {
      try {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 8) {
          return {
            ok: false,
            error: { code: 'invoke.too_short', message: 'response too short' },
          };
        }
        if (bytes[0] !== 1) return { ok: false, error: decodeErrorFrame(bytes) };
        const reader = new Reader(bytes, maxCollectionLength);
        reader.raw(8);
        const result = decodeNode(
          reader,
          options.outputSchema,
          definitions,
          maxDepth,
          0,
          maxCollectionLength,
        ) as O;
        if (reader.remaining !== 0)
          throw new ComplexCodecError('trailing bytes in complex response');
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'invoke.malformed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
