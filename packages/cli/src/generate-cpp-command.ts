import type { CommandSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { collectPostcardFields } from './generate-postcard-graph.js';
import { cppFieldEncodeExpr } from './generate-cpp-encode.js';
import { cppProperties } from './generate-cpp-properties.js';

export function cppEncodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const fields = collectPostcardFields(command.inputSchema, definitions).fields;
  const properties = cppProperties(fields, definitions);
  const lines = [
    `static void encode_${fnName}(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {`,
    `  w.push_u8(${command.commandId & 0xff}); w.push_u8(${(command.commandId >> 8) & 0xff}); // cmd_id = ${command.commandId} LE`,
    `  auto argsObj = args.asObject(rt);`,
    ...properties.declarations,
  ];
  for (const field of fields)
    lines.push(cppFieldEncodeExpr(field, 'argsObj', definitions, '  ', properties.property));
  lines.push('}');
  return lines.join('\n') + '\n';
}
