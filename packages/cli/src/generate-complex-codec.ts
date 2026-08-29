import type { CommandSchema, JsonSchema } from './schema.js';
import type { RkyvV2Codec } from '@rustra/types';
import { commandFunctionName } from './codegen.js';
import { buildCodecIr } from './codec-ir.js';
import { commandCodecSupported } from './generate-postcard-support.js';

export function complexSchemaSupported(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): boolean {
  return buildCodecIr(schema, definitions).ok;
}

export function generateComplexCodec(
  command: CommandSchema,
  definitions: Record<string, JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  const outType = command.outputType === '()' ? 'void' : command.outputType;
  return (
    `/** route: complex-binary; RN uses native C++ when the schema is native-safe, otherwise JS. */\n` +
    `export const ${fnName}ComplexCodec: RkyvV2Codec<${inType}, ${outType}> = createComplexCodec<${inType}, ${outType}>({\n` +
    `  commandId: ${command.commandId},\n` +
    `  inputSchema: ${JSON.stringify(command.inputSchema)} as ComplexSchema,\n` +
    `  outputSchema: ${JSON.stringify(command.outputSchema)} as ComplexSchema,\n` +
    `  definitions: ${JSON.stringify(definitions)} as Record<string, ComplexSchema>,\n` +
    `});\n\n` +
    `export const ${fnName}Codec = ${fnName}ComplexCodec;\n\n`
  );
}

export { commandCodecSupported };
