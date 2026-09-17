import type { CommandSchema, JsonSchema } from './schema.js';

export function validateFunctionArgs(
  command: Pick<CommandSchema, 'functionArgs' | 'inputSchema'>,
): void {
  const arity = command.functionArgs;
  if (arity === undefined) return;
  const schema: JsonSchema = command.inputSchema;
  const items = schema?.items;
  if (
    !Number.isInteger(arity) ||
    arity < 0 ||
    arity > 12 ||
    (arity === 0
      ? schema?.type !== 'null'
      : schema?.type !== 'array' ||
        !Array.isArray(items) ||
        items.length !== arity ||
        schema.minItems !== arity ||
        schema.maxItems !== arity)
  ) {
    throw new Error(
      'Invalid schema: functionArgs must be 0..12 and match a fixed input tuple (or null for zero arguments)',
    );
  }
}
