import type { JsonSchema } from './schema.js';
import { resolveRef, escapeStringLiteral, escapeJsDoc } from './codegen-text.js';
import { recordUnknownFallback } from './codegen-warnings.js';

export function tsTypeFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (schema.$ref) return resolveRef(schema.$ref);
  if (schema.allOf)
    return schema.allOf.map((item) => tsTypeFromSchema(item, definitions)).join(' & ');
  if (schema.anyOf)
    return schema.anyOf.map((item) => tsTypeFromSchema(item, definitions)).join(' | ');
  if (schema.oneOf)
    return schema.oneOf.map((item) => tsTypeFromSchema(item, definitions)).join(' | ');
  const type = schema.type;
  if (typeof type === 'string') {
    switch (type) {
      case 'object':
        if (
          !schema.properties &&
          schema.additionalProperties &&
          typeof schema.additionalProperties === 'object'
        ) {
          return `Record<string, ${tsTypeFromSchema(schema.additionalProperties, definitions)}>`;
        }
        return tsObjectFromSchema(schema, definitions);
      case 'integer':
        if (schema.enum?.length) return schema.enum.map(String).join(' | ');
        return schema.format === 'int64' || schema.format === 'uint64'
          ? 'number | bigint'
          : 'number';
      case 'number':
        return 'number';
      case 'string':
        return schema.enum?.length
          ? schema.enum.map((value) => `'${escapeStringLiteral(String(value))}'`).join(' | ')
          : 'string';
      case 'boolean':
        return 'boolean';
      case 'array': {
        if (Array.isArray(schema.items)) return arrayItemType(schema, definitions);
        if (schema.items?.type === 'integer' && schema.items.format === 'uint8')
          return 'Uint8Array | ArrayBuffer | number[]';
        const itemType = arrayItemType(schema, definitions);
        if (schema.uniqueItems) return `Set<${itemType}>`;
        if (itemType.includes(' | ')) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      case 'null':
        return 'null';
      default:
        return recordUnknownFallback(schema);
    }
  }
  if (Array.isArray(type))
    return [...new Set(type.map((member) => unionMemberType(member, schema, definitions)))].join(
      ' | ',
    );
  return recordUnknownFallback(schema);
}

function unionMemberType(
  member: string,
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  switch (member) {
    case 'integer':
      return schema.format === 'int64' || schema.format === 'uint64' ? 'number | bigint' : 'number';
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
    case 'array': {
      const itemType = arrayItemType(schema, definitions);
      return itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`;
    }
    default:
      return recordUnknownFallback(schema);
  }
}

function arrayItemType(schema: JsonSchema, definitions: Record<string, JsonSchema>): string {
  if (Array.isArray(schema.items))
    return `[${schema.items.map((item) => tsTypeFromSchema(item, definitions)).join(', ')}]`;
  return schema.items ? tsTypeFromSchema(schema.items, definitions) : recordUnknownFallback(schema);
}

export function tsObjectFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (!schema.properties) return 'Record<string, unknown>';
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties)
    .map(([name, propSchema]) => {
      const description =
        typeof propSchema.description === 'string'
          ? `  /** ${escapeJsDoc(propSchema.description).replace(/\n/g, ' ')} */\n`
          : '';
      return `${description}  ${name}${required.has(name) ? '' : '?'}: ${constLiteral(propSchema) ?? tsTypeFromSchema(propSchema, definitions)};`;
    })
    .join('\n');
  return `{\n${fields}\n}`;
}

function constLiteral(schema: JsonSchema): string | null {
  if (schema.const === undefined) return null;
  if (typeof schema.const === 'string') return `'${escapeStringLiteral(schema.const)}'`;
  return typeof schema.const === 'number' || typeof schema.const === 'boolean'
    ? String(schema.const)
    : null;
}
