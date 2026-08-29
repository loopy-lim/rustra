import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError } from './complex-codec-types.js';
import { Reader } from './complex-codec-reader.js';
import { decodeObject } from './complex-codec-decode-object.js';
import { decodeVariant } from './complex-codec-decode-variant.js';
import {
  isUnsigned,
  optionInner,
  readPresence,
  resolvedSchema,
  toJsInteger,
} from './complex-codec-schema.js';
import { variants } from './complex-codec-variants.js';

export function decodeNode(
  reader: Reader,
  rawSchema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): unknown {
  if (depth > maxDepth) throw new ComplexCodecError(`value depth exceeds ${maxDepth}`);
  const schema = resolvedSchema(rawSchema, definitions, depth);
  const inner = optionInner(schema);
  if (inner)
    return readPresence(reader, 'option')
      ? decodeNode(reader, inner, definitions, maxDepth, depth + 1, maxCollectionLength)
      : null;
  if (schema.oneOf) {
    const choices = variants(schema);
    const index = Number(reader.varint());
    if (!choices[index]) throw new ComplexCodecError('enum variant index out of range');
    return decodeVariant(
      reader,
      choices[index].schema,
      definitions,
      maxDepth,
      depth + 1,
      maxCollectionLength,
    );
  }
  if (schema.enum) {
    const index = Number(reader.varint());
    if (index < 0 || index >= schema.enum.length)
      throw new ComplexCodecError('enum index out of range');
    return schema.enum[index];
  }
  if (schema.type === 'boolean') {
    const value = reader.byte();
    if (value > 1) throw new ComplexCodecError('invalid boolean value');
    return value === 1;
  }
  if (schema.type === 'integer')
    return toJsInteger(isUnsigned(schema) ? reader.varint() : reader.zigzag(), schema);
  if (schema.type === 'number') {
    const bytes = reader.raw(schema.format === 'float' ? 4 : 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return schema.format === 'float' ? view.getFloat32(0, true) : view.getFloat64(0, true);
  }
  if (schema.type === 'string') return reader.string();
  if (schema.type === 'null') return null;
  if (schema.type === 'array') {
    const length = reader.length();
    const items = schema.items;
    if (Array.isArray(items)) {
      if (items.length !== length) throw new ComplexCodecError('tuple length mismatch');
      return items.map((item) =>
        decodeNode(reader, item, definitions, maxDepth, depth + 1, maxCollectionLength),
      );
    }
    if (!items) throw new ComplexCodecError('array schema is missing items');
    const values = Array.from({ length }, () =>
      decodeNode(reader, items, definitions, maxDepth, depth + 1, maxCollectionLength),
    );
    return schema.uniqueItems ? new Set(values) : values;
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && !schema.properties) {
      if (!schema.additionalProperties || typeof schema.additionalProperties === 'boolean')
        throw new ComplexCodecError('map schema is missing value type');
      const result: Record<string, unknown> = {};
      const length = reader.length();
      for (let i = 0; i < length; i += 1) {
        const key = reader.string();
        if (Object.prototype.hasOwnProperty.call(result, key))
          throw new ComplexCodecError(`duplicate map key ${key}`);
        result[key] = decodeNode(
          reader,
          schema.additionalProperties,
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        );
      }
      return result;
    }
    return decodeObject(reader, schema, definitions, maxDepth, depth, maxCollectionLength);
  }
  throw new ComplexCodecError(`unsupported schema type ${String(schema.type)}`);
}
