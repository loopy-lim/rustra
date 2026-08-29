import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError } from './complex-codec-types.js';
import { Writer, sortedKeys } from './complex-codec-wire.js';
import { encodeObject } from './complex-codec-encode-object.js';
import { encodeVariant } from './complex-codec-encode-variant.js';
import {
  isUnsigned,
  optionInner,
  resolvedSchema,
  toInteger,
  validateInteger,
} from './complex-codec-schema.js';
import { matchesVariant, variants } from './complex-codec-variants.js';

export function encodeNode(
  writer: Writer,
  rawSchema: ComplexSchema,
  value: unknown,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
): void {
  if (depth > maxDepth) throw new ComplexCodecError(`value depth exceeds ${maxDepth}`);
  const schema = resolvedSchema(rawSchema, definitions, depth);
  const inner = optionInner(schema);
  if (inner) {
    if (value === null || value === undefined) {
      writer.byte(0);
    } else {
      writer.byte(1);
      encodeNode(writer, inner, value, definitions, maxDepth, depth + 1, maxCollectionLength);
    }
    return;
  }
  if (schema.oneOf) {
    const choices = variants(schema);
    const selected = choices.findIndex(({ schema: variant }) => matchesVariant(variant, value));
    if (selected < 0) throw new ComplexCodecError('value does not match any enum variant');
    writer.varint(BigInt(selected));
    encodeVariant(
      writer,
      choices[selected].schema,
      value,
      definitions,
      maxDepth,
      depth + 1,
      maxCollectionLength,
    );
    return;
  }
  if (schema.enum) {
    const index = schema.enum.findIndex((candidate) => Object.is(candidate, value));
    if (index < 0) throw new ComplexCodecError('value is not a member of enum');
    writer.varint(BigInt(index));
    return;
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    throw new ComplexCodecError(`value does not match const ${String(schema.const)}`);
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ComplexCodecError('expected boolean');
    writer.byte(value ? 1 : 0);
  } else if (schema.type === 'integer') {
    const integer = validateInteger(toInteger(value), schema);
    if (isUnsigned(schema)) writer.varint(integer);
    else writer.zigzag(integer);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new ComplexCodecError('expected finite number');
    const buffer = new ArrayBuffer(schema.format === 'float' ? 4 : 8);
    const view = new DataView(buffer);
    if (buffer.byteLength === 4) view.setFloat32(0, value, true);
    else view.setFloat64(0, value, true);
    writer.push(new Uint8Array(buffer));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ComplexCodecError('expected string');
    writer.string(value);
  } else if (schema.type === 'null') {
    if (value !== null) throw new ComplexCodecError('expected null');
  } else if (schema.type === 'array') {
    const items = schema.items;
    const values = value instanceof Set ? [...value] : value;
    if (!Array.isArray(values)) throw new ComplexCodecError('expected array or Set');
    if (values.length > maxCollectionLength)
      throw new ComplexCodecError(`collection length exceeds ${maxCollectionLength}`);
    writer.varint(BigInt(values.length));
    if (Array.isArray(items)) {
      if (items.length !== values.length) throw new ComplexCodecError('tuple length mismatch');
      items.forEach((item, index) =>
        encodeNode(
          writer,
          item,
          values[index],
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        ),
      );
    } else if (items) {
      values.forEach((item) =>
        encodeNode(writer, items, item, definitions, maxDepth, depth + 1, maxCollectionLength),
      );
    } else {
      throw new ComplexCodecError('array schema is missing items');
    }
  } else if (schema.type === 'object') {
    if (schema.additionalProperties !== undefined && !schema.properties) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ComplexCodecError('expected object map');
      const map = value as Record<string, unknown>;
      const keys = sortedKeys(map);
      if (keys.length > maxCollectionLength)
        throw new ComplexCodecError(`collection length exceeds ${maxCollectionLength}`);
      writer.varint(BigInt(keys.length));
      for (const key of keys) {
        writer.string(key);
        if (!schema.additionalProperties || typeof schema.additionalProperties === 'boolean')
          throw new ComplexCodecError('map schema is missing value type');
        encodeNode(
          writer,
          schema.additionalProperties,
          map[key],
          definitions,
          maxDepth,
          depth + 1,
          maxCollectionLength,
        );
      }
    } else {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ComplexCodecError('expected object');
      encodeObject(
        writer,
        schema,
        value as Record<string, unknown>,
        definitions,
        maxDepth,
        depth,
        maxCollectionLength,
      );
    }
  } else {
    throw new ComplexCodecError(`unsupported schema type ${String(schema.type)}`);
  }
}
