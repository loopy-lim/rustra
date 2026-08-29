import type { ComplexSchema } from './complex-codec-types.js';
import { Writer } from './complex-codec-wire.js';
import { discriminator } from './complex-codec-variants.js';
import { encodeNode } from './complex-codec-encode-node.js';
import { encodeObject } from './complex-codec-encode-object.js';

export function encodeVariant(
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
