import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError } from './complex-codec-types.js';
import { Reader } from './complex-codec-reader.js';
import { decodeNode } from './complex-codec-decode-node.js';
import { readPresence } from './complex-codec-schema.js';

export function decodeObject(
  reader: Reader,
  schema: ComplexSchema,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
  skipKey?: string,
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (key === skipKey) continue;
    const present = required.has(key) || readPresence(reader, `optional field ${key}`);
    if (present)
      result[key] = decodeNode(
        reader,
        fieldSchema,
        definitions,
        maxDepth,
        depth + 1,
        maxCollectionLength,
      );
    else if (required.has(key)) throw new ComplexCodecError(`missing required field ${key}`);
  }
  return result;
}
