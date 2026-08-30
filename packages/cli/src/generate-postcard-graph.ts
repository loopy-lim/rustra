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

export function collectPostcardFields(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): { fields: PostcardField[]; unsupported: string[] } {
  const fields: PostcardField[] = [];
  const unsupported: string[] = [];
  for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
    const kind = classifyPostcardField(propSchema, definitions);
    if (!kind) {
      unsupported.push(name);
      continue;
    }
    const field: PostcardField = { name, kind };
    if (kind === 'enum_str' && Array.isArray(propSchema.enum)) {
      field.enumVariants = propSchema.enum.filter(
        (value): value is string => typeof value === 'string',
      );
    }
    if (kind === 'struct' && propSchema.$ref) field.refType = refTypeName(propSchema.$ref);
    if (kind === 'tuple' && Array.isArray(propSchema.items)) {
      field.tupleItems = propSchema.items
        .map((item) => {
          const itemKind = classifyPostcardField(item, definitions);
          return itemKind ? ({ name: '_', kind: itemKind } as PostcardField) : null;
        })
        .filter((item): item is PostcardField => item !== null);
    }
    if ((kind === 'vec_struct' || kind === 'option_struct') && !field.refType) {
      const items = propSchema.items;
      const itemsRef = items && !Array.isArray(items) ? items.$ref : undefined;
      const innerRef = itemsRef ?? propSchema.anyOf?.find((item) => item.$ref)?.$ref ?? undefined;
      if (innerRef) field.refType = refTypeName(innerRef);
    }
    fields.push(field);
  }
  return { fields, unsupported };
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
