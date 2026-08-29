import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError, DEFAULT_MAX_DEPTH } from './complex-codec-types.js';
import type { Reader } from './complex-codec-reader.js';

export function isUnsigned(schema: ComplexSchema): boolean {
  return typeof schema.format === 'string' && schema.format.startsWith('uint');
}

export function toInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new ComplexCodecError('integer must be a safe number or bigint');
}

export function integerBounds(schema: ComplexSchema): { min: bigint; max: bigint } {
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

export function validateInteger(value: bigint, schema: ComplexSchema): bigint {
  const { min, max } = integerBounds(schema);
  if (value < min || value > max) {
    throw new ComplexCodecError(`integer is outside ${String(min)}..${String(max)}`);
  }
  return value;
}

export function toJsInteger(value: bigint, schema: ComplexSchema): number | bigint {
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

export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

export function resolvedSchema(
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

export function optionInner(schema: ComplexSchema): ComplexSchema | null {
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

export function readPresence(reader: Reader, label: string): boolean {
  const tag = reader.byte();
  if (tag === 0) return false;
  if (tag === 1) return true;
  throw new ComplexCodecError(`invalid ${label} presence tag`);
}
