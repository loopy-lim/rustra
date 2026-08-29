import type { ComplexSchema } from './complex-codec-types.js';
import { ComplexCodecError } from './complex-codec-types.js';
import { Writer } from './complex-codec-wire.js';
import { encodeNode } from './complex-codec-encode-node.js';

export function encodeObject(
  writer: Writer,
  schema: ComplexSchema,
  value: Record<string, unknown>,
  definitions: Record<string, ComplexSchema>,
  maxDepth: number,
  depth: number,
  maxCollectionLength: number,
  skipKey?: string,
): void {
  const required = new Set(schema.required ?? []);
  for (const [key, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (key === skipKey) continue;
    const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (!required.has(key)) writer.byte(present ? 1 : 0);
    if (present)
      encodeNode(
        writer,
        fieldSchema,
        value[key],
        definitions,
        maxDepth,
        depth + 1,
        maxCollectionLength,
      );
    else if (required.has(key)) throw new ComplexCodecError(`missing required field ${key}`);
  }
}
