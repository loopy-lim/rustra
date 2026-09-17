import type { JsonSchema, PackageSchema } from './schema.js';
import { classifyPostcardField } from './generate-postcard-classify.js';
import type { PostcardField } from './generate-postcard-types.js';

export function unwrapOptionSchema(schema: JsonSchema): JsonSchema | null {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== 'null');
    if (schema.type.length === 2 && nonNull.length === 1) {
      return { ...schema, type: nonNull[0] } as JsonSchema;
    }
    return null;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const nonNull = schema.anyOf.filter((item) => item.type !== 'null' && !('anyOf' in item));
    return nonNull.length === 1 && schema.anyOf.some((item) => item.type === 'null')
      ? nonNull[0]
      : null;
  }
  return null;
}

export function postcardField(
  name: string,
  source: JsonSchema,
  definitions: Record<string, JsonSchema>,
  depth = 0,
): PostcardField | null {
  if (depth > 8) return null;
  if (source.allOf?.length === 1)
    return postcardField(name, source.allOf[0], definitions, depth + 1);
  if (source.$ref) {
    const resolved = definitions[refTypeName(source.$ref)];
    if (!resolved) return null;
    if (resolved.type !== 'object' || !resolved.properties || resolved.additionalProperties)
      return postcardField(name, resolved, definitions, depth + 1);
  }
  const kind = classifyPostcardField(source, definitions);
  if (!kind) return null;
  const field: PostcardField = { name, kind };
  if (kind === 'enum_str') field.enumVariants = source.enum as string[];
  if (kind === 'struct' && source.$ref) field.refType = refTypeName(source.$ref);
  if (kind === 'tuple' && Array.isArray(source.items)) {
    const items = source.items.map((item) => postcardField('_', item, definitions, depth + 1));
    if (items.some((item) => item === null)) return null;
    field.tupleItems = items as PostcardField[];
  }
  if (kind === 'vec_struct' || kind === 'option_struct') {
    const inner = kind === 'option_struct' ? unwrapOptionSchema(source) : source.items;
    const ref = inner && !Array.isArray(inner) ? inner.$ref : undefined;
    if (!ref) return null;
    field.refType = refTypeName(ref);
  }
  return field;
}

export function collectPostcardFields(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): { fields: PostcardField[]; unsupported: string[] } {
  const entries =
    schema.type === 'null'
      ? []
      : schema.type === 'object' && !schema.additionalProperties
        ? Object.entries(schema.properties ?? {})
        : schema.type === 'array' && Array.isArray(schema.items)
          ? schema.items.map((item, i) => [String(i), item] as const)
          : [['', schema] as const];
  const fields: PostcardField[] = [];
  const unsupported: string[] = [];
  for (const [name, source] of entries) {
    const field = postcardField(name, source, definitions);
    if (field) fields.push(field);
    else unsupported.push(name);
  }
  return { fields, unsupported };
}

/** Root tuples are positional; all other non-object roots are a single value. */
export function postcardRootAccess(schema: JsonSchema, root: string, name: string): string {
  if (schema.type === 'object' && !schema.additionalProperties) return `${root}.${name}`;
  if (schema.type === 'array' && Array.isArray(schema.items)) return `${root}[${name}]`;
  return root;
}

export function refTypeName(ref: string): string {
  return ref.startsWith('#/definitions/') ? ref.slice('#/definitions/'.length) : ref;
}

export function schemaChildren(schema: JsonSchema): JsonSchema[] {
  const children = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    children.push(schema.additionalProperties);
  }
  return children;
}

export function hasCyclicRef(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  path = new Set<string>(),
  visited = new Set<JsonSchema>(),
): boolean {
  if (visited.has(schema)) return false;
  visited.add(schema);
  if (schema.$ref) {
    const name = refTypeName(schema.$ref);
    if (path.has(name)) return true;
    const definition = definitions[name];
    if (!definition) return false;
    const nextPath = new Set(path);
    nextPath.add(name);
    return hasCyclicRef(definition, definitions, nextPath, visited);
  }
  return schemaChildren(schema).some((child) => hasCyclicRef(child, definitions, path, visited));
}

export function hasSet(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  path = new Set<string>(),
): boolean {
  if (schema.uniqueItems === true) return true;
  if (schema.$ref) {
    const name = refTypeName(schema.$ref);
    if (path.has(name)) return false;
    const definition = definitions[name];
    if (!definition) return false;
    const nextPath = new Set(path);
    nextPath.add(name);
    return hasSet(definition, definitions, nextPath);
  }
  return schemaChildren(schema).some((child) => hasSet(child, definitions, path));
}

export function collectAllDefinitions(schema: PackageSchema): Record<string, JsonSchema> {
  const definitions: Record<string, JsonSchema> = {};
  for (const command of schema.commands) {
    Object.assign(definitions, command.definitions, command.inputSchema.definitions);
    Object.assign(definitions, command.outputSchema.definitions);
  }
  return definitions;
}

/** Fixed homogeneous arrays must not use a length-prefixed vector emitter. */
export function hasFixedArray(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  if (schema.$ref) {
    const target = definitions[refTypeName(schema.$ref)];
    return !!target && hasFixedArray(target, definitions, depth + 1);
  }
  if (
    schema.type === 'array' &&
    schema.items &&
    !Array.isArray(schema.items) &&
    Number.isInteger(schema.minItems) &&
    schema.minItems === schema.maxItems
  )
    return true;
  return schemaChildren(schema).some((child) => hasFixedArray(child, definitions, depth + 1));
}
