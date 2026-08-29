import type { JsonSchema } from './schema.js';
import { refTypeName, unwrapOptionSchema } from './generate-postcard-graph.js';
import type { PostcardFieldKind } from './generate-postcard-types.js';

/** Classify one schema property into its postcard wire encoding kind. */
export function classifyPostcardField(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  depth = 0,
): PostcardFieldKind | null {
  if (depth > 8) return null;
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return classifyPostcardField(schema.allOf[0], definitions, depth + 1);
  }
  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every((value) => typeof value === 'string')) return 'enum_str';
  }
  if (schema.$ref) {
    const resolved = definitions[refTypeName(schema.$ref)];
    if (!resolved) return 'struct';
    if (resolved.type === 'object' && resolved.properties && !resolved.additionalProperties) {
      return 'struct';
    }
    return classifyPostcardField(resolved, definitions, depth + 1);
  }
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'integer') {
    if (schema.format === 'uint64') return 'uvar64';
    if (schema.format === 'int64') return 'zigzag64';
    const unsigned = ['uint8', 'uint16', 'uint32'].includes(schema.format ?? '');
    return unsigned ? 'uvar' : 'zigzag';
  }
  if (schema.type === 'number') return schema.format === 'float' ? 'f32' : 'f64';
  if (schema.type === 'string') return 'string';

  const optionInner = unwrapOptionSchema(schema);
  if (optionInner) {
    const inner = classifyPostcardField(optionInner, definitions);
    const optionKind: Partial<Record<PostcardFieldKind, PostcardFieldKind>> = {
      zigzag: 'option_zigzag',
      uvar: 'option_uvar',
      zigzag64: 'option_zigzag64',
      uvar64: 'option_uvar64',
      f64: 'option_f64',
      f32: 'option_f32',
      bool: 'option_bool',
      string: 'option_string',
      struct: 'option_struct',
      bytes: 'option_bytes',
    };
    return inner ? (optionKind[inner] ?? null) : null;
  }

  if (schema.type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = schema.items;
    if (items.type === 'integer' && items.format === 'uint8') return 'bytes';
    if (items.type === 'integer') {
      const unsigned = ['uint8', 'uint16', 'uint32'].includes(items.format ?? '');
      if (items.format === 'uint64') return schema.uniqueItems ? 'set_u64' : 'vec_u64';
      if (items.format === 'int64') return schema.uniqueItems ? 'set_i64' : 'vec_i64';
      if (unsigned) return schema.uniqueItems ? 'set_uvar' : 'vec_uvar';
      return schema.uniqueItems ? 'set_zigzag' : 'vec_zigzag';
    }
    if (items.type === 'number') return schema.uniqueItems ? 'set_f64' : 'vec_f64';
    if (items.type === 'boolean') return schema.uniqueItems ? 'set_bool' : 'vec_bool';
    if (items.type === 'string') return 'vec_string';
    if (items.$ref) {
      const resolved = definitions[refTypeName(items.$ref)];
      if (!resolved) return 'vec_struct';
      if (resolved.type === 'object' && resolved.properties && !resolved.additionalProperties) {
        return 'vec_struct';
      }
      const inner = classifyPostcardField(resolved, definitions, depth + 1);
      return inner === 'struct' ? 'vec_struct' : inner === 'string' ? 'vec_string' : null;
    }
    return null;
  }

  if (schema.type === 'array' && Array.isArray(schema.items)) {
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems === maxItems && minItems !== undefined && minItems > 0) {
      return schema.items.every((item) => classifyPostcardField(item, definitions, depth + 1))
        ? 'tuple'
        : null;
    }
    return null;
  }
  if (schema.oneOf) return null;
  return classifyMap(schema);
}

function classifyMap(schema: JsonSchema): PostcardFieldKind | null {
  if (
    schema.type !== 'object' ||
    !schema.additionalProperties ||
    typeof schema.additionalProperties !== 'object' ||
    schema.properties
  ) {
    return null;
  }
  const value = schema.additionalProperties;
  if (value.type === 'integer') {
    if (value.format === 'uint64') return 'map_u64';
    if (value.format === 'int64') return 'map_i64';
    return ['uint8', 'uint16', 'uint32'].includes(value.format ?? '') ? 'map_uvar' : 'map_zigzag';
  }
  if (value.type === 'number') return 'map_f64';
  if (value.type === 'boolean') return 'map_bool';
  if (value.type === 'string') return 'map_string';
  return null;
}
