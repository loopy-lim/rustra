import type { CommandSchema, JsonSchema } from './schema.js';
import { bufferCommandField, generatedFieldRoute } from './generate-routing.js';

/** Route metadata uses the same eligibility and field order as native codegen. */
export function generatedSyncMetadata(
  command: CommandSchema,
  definitions: Record<string, JsonSchema>,
): string[] {
  if (!command.execution) return [];
  const lines = [`  execution: ${JSON.stringify(command.execution)},`];
  const fields = generatedFieldRoute(command, definitions);
  if (fields) lines.push(`  syncFields: ${JSON.stringify(fields.map((field) => field.name))},`);
  const bytes = bufferCommandField(command, definitions);
  if (bytes) lines.push(`  syncByteField: ${JSON.stringify(bytes.name)},`);
  return lines;
}
