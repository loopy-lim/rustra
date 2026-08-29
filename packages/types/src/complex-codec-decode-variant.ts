import type { ComplexSchema } from './complex-codec-types.js';
import { Reader } from './complex-codec-reader.js';
import { discriminator } from './complex-codec-variants.js';
import { decodeNode } from './complex-codec-decode-node.js';
import { decodeObject } from './complex-codec-decode-object.js';

export function decodeVariant(
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
