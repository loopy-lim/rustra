import type { CommandSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { collectPostcardFields } from './generate-postcard-graph.js';
import { cppFieldEncodeExpr } from './generate-cpp-encode.js';

export function cppEncodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const lines = [
    `static void encode_${fnName}(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {`,
    `  w.push_u8(${command.commandId & 0xff}); w.push_u8(${(command.commandId >> 8) & 0xff}); // cmd_id = ${command.commandId} LE`,
    `  auto argsObj = args.asObject(rt);`,
  ];
  for (const field of collectPostcardFields(command.inputSchema, definitions).fields)
    lines.push(cppFieldEncodeExpr(field, 'argsObj', definitions, '  '));
  lines.push('}');
  return lines.join('\n') + '\n';
}
