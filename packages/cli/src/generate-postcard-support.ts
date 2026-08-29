import type { CommandSchema, JsonSchema } from './schema.js';
import { buildCodecIr } from './codec-ir.js';
import {
  collectPostcardFields,
  hasCyclicRef,
  hasSet,
  refTypeName,
} from './generate-postcard-ir.js';

function collectNestedUnsupported(
  command: CommandSchema,
  definitions: Record<string, JsonSchema>,
): string[] {
  const bad: string[] = [];
  const visited = new Set<string>();
  const refOf = (schema: JsonSchema): string | undefined => {
    if (schema.$ref) return schema.$ref;
    if (schema.allOf?.length === 1 && schema.allOf[0]?.$ref) return schema.allOf[0].$ref;
    if (schema.items && !Array.isArray(schema.items) && schema.items.$ref) return schema.items.$ref;
    return undefined;
  };
  const checkRef = (reference: string) => {
    if (visited.has(reference)) return;
    visited.add(reference);
    const definition = definitions[reference];
    if (!definition) return;
    if (collectPostcardFields(definition, definitions).unsupported.length > 0) bad.push(reference);
    for (const child of Object.values(definition.properties ?? {})) {
      const ref = refOf(child);
      if (ref) checkRef(refTypeName(ref));
    }
  };
  for (const schema of [command.inputSchema, command.outputSchema]) {
    for (const property of Object.values(schema.properties ?? {})) {
      const ref = refOf(property);
      if (ref) checkRef(refTypeName(ref));
    }
  }
  return bad;
}

export function commandCodecSupported(
  command: CommandSchema,
  definitions: Record<string, JsonSchema>,
): boolean {
  if (command.inputType !== '()' && command.inputSchema.type !== 'object') return false;
  if (command.outputType !== '()' && command.outputSchema.type !== 'object') return false;
  if (
    hasCyclicRef(command.inputSchema, definitions) ||
    hasCyclicRef(command.outputSchema, definitions)
  ) {
    return false;
  }
  if (hasSet(command.inputSchema, definitions) || hasSet(command.outputSchema, definitions))
    return false;
  const input = collectPostcardFields(command.inputSchema, definitions);
  const output = collectPostcardFields(command.outputSchema, definitions);
  return (
    input.unsupported.length === 0 &&
    output.unsupported.length === 0 &&
    collectNestedUnsupported(command, definitions).length === 0
  );
}

export function complexCodecSupported(
  command: CommandSchema,
  definitions: Record<string, JsonSchema>,
): boolean {
  return (
    !commandCodecSupported(command, definitions) &&
    buildCodecIr(command.inputSchema, definitions).ok &&
    buildCodecIr(command.outputSchema, definitions).ok
  );
}
