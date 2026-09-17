import type { ComplexSchema } from './complex-codec-types.js';

/** Named object envelopes do not consume the historical field-depth budget. */
export function isNamedPostcardRoot(schema: ComplexSchema): boolean {
  return (
    schema.type === 'object' &&
    schema.properties !== undefined &&
    (schema.additionalProperties === undefined || schema.additionalProperties === false)
  );
}

export function postcardSchemaSupported(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
): boolean {
  return isNamedPostcardRoot(schema)
    ? Object.values(schema.properties!).every((field) =>
        postcardNodeSupported(field, definitions, 0),
      )
    : postcardNodeSupported(schema, definitions, 0);
}

/** Mirror Rust's frame_support.rs route gate before compiling live root nodes.
 * Keep unsupported optional/collection shapes on the same complex wire route.
 */
function postcardNodeSupported(
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  depth = 0,
): boolean {
  if (depth > 8 || schema.uniqueItems === true) return false;
  if (schema.allOf)
    return (
      schema.allOf.length === 1 && postcardNodeSupported(schema.allOf[0], definitions, depth + 1)
    );
  if (schema.$ref) {
    const target = definitions[schema.$ref.split('/').pop()!];
    return !!target && postcardNodeSupported(target, definitions, depth + 1);
  }
  if (schema.anyOf) {
    const refs = schema.anyOf.filter((node) => node.$ref);
    const target = refs.length === 1 ? definitions[refs[0].$ref!.split('/').pop()!] : undefined;
    return (
      schema.anyOf.length === 2 &&
      refs.length === 1 &&
      schema.anyOf.some((node) => node.type === 'null') &&
      !!target &&
      postcardNodeSupported(target, definitions, depth + 1)
    );
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== 'null');
    return (
      schema.type.length === 2 &&
      schema.type.includes('null') &&
      types.length === 1 &&
      ['integer', 'number', 'boolean', 'string'].includes(types[0])
    );
  }
  if (schema.oneOf) return false;
  if (schema.type === 'array') {
    if (Array.isArray(schema.items))
      return (
        schema.minItems === schema.items.length &&
        schema.maxItems === schema.items.length &&
        schema.items.every((item) => postcardNodeSupported(item, definitions, depth + 1))
      );
    const item = schema.items?.$ref
      ? definitions[schema.items.$ref.split('/').pop()!]
      : schema.items;
    return !!item && postcardNodeSupported(item, definitions, depth + 1);
  }
  if (schema.type === 'object') {
    const value = schema.additionalProperties;
    if (value !== undefined && value !== false)
      return (
        !schema.properties &&
        typeof value === 'object' &&
        value.type !== 'object' &&
        value.type !== 'array' &&
        postcardNodeSupported(value, definitions, depth + 1)
      );
    return Object.values(schema.properties ?? {}).every((item) =>
      postcardNodeSupported(item, definitions, depth + 1),
    );
  }
  return ['null', 'integer', 'number', 'boolean', 'string'].includes(schema.type ?? '');
}
