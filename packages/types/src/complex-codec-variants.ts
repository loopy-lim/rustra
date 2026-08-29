import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError } from './complex-codec-types.js';
import { compareUtf8 } from './complex-codec-wire.js';

export type Variant = { schema: ComplexSchema; key: string };

export function variantKey(schema: ComplexSchema): string | null {
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

export function variants(schema: ComplexSchema): Variant[] {
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

export function discriminator(schema: ComplexSchema): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (value.const !== undefined) return { key, value: value.const };
  }
  return null;
}

export function matchesVariant(schema: ComplexSchema, value: unknown): boolean {
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
