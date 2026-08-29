import type { JsonSchema } from './schema.js';
export const MAX_SCHEMA_DEPTH = 32;

export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Sort keys by the bytes put on the wire, not by UTF-16 code units. */
export function compareCodecKeys(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function primitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function explicitVariantKeys(schema: JsonSchema, count: number): string[] | null {
  const value = schema['x-rustra-variant-order'];
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  const keys = value as string[];
  return new Set(keys).size === keys.length ? keys : null;
}

/** Derives the stable identity used by both TS and C++ oneOf codecs. */
export function codecVariantKey(schema: JsonSchema): string | null {
  if (primitive(schema.const) && typeof schema.const === 'string') return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && primitive(schema.enum[0])) {
    return String(schema.enum[0]);
  }
  if (schema.properties) {
    const discriminator = Object.entries(schema.properties).find(
      ([, value]) => primitive(value.const) && value.const !== undefined,
    );
    if (discriminator) return String(discriminator[1].const);
    const keys = Object.keys(schema.properties);
    if (keys.length === 1) return keys[0];
  }
  return typeof schema.title === 'string' ? schema.title : null;
}

export function discriminator(
  schema: JsonSchema,
): { key: string; value: string | number | boolean | null } | null {
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (primitive(value.const) && value.const !== undefined) {
      return { key, value: value.const as string | number | boolean | null };
    }
  }
  return null;
}

export function optionalInner(schema: JsonSchema): JsonSchema | null {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== 'null');
    if (schema.type.length === 2 && nonNull.length === 1) {
      return { ...schema, type: nonNull[0] };
    }
  }
  if (schema.anyOf?.length === 2) {
    const nonNull = schema.anyOf.filter((item) => item.type !== 'null');
    if (nonNull.length === 1) return nonNull[0];
  }
  return null;
}
