import type { PackageSchema } from './schema.js';
import type { CommandSchema } from './schema.js';
import { buildCodecIr } from './codec-ir.js';
import { collectAllDefinitions } from './generate-postcard-ir.js';
import { commandCodecSupported } from './generate-postcard-support.js';
import { bufferCommandResultField, rawCommandShape } from './generate-cpp-routes.js';
import { bufferCommandField } from './generate-routing.js';
import { cppEncodePosCommand } from './generate-cpp-routes.js';
import { cppComplexNativeSupported } from './generate-cpp-complex.js';
import type { CppCommandSets } from './generate-cpp-output-types.js';

export function analyzeCppCommands(schema: PackageSchema): CppCommandSets {
  const definitions = collectAllDefinitions(schema);
  const supported = schema.commands.filter((command) =>
    commandCodecSupported(command, definitions),
  );
  const complexSupported = schema.commands
    .map((command) => {
      if (commandCodecSupported(command, definitions)) return null;
      const input = buildCodecIr(command.inputSchema, definitions);
      const output = buildCodecIr(command.outputSchema, definitions);
      return input.ok &&
        output.ok &&
        cppComplexNativeSupported(input.node, definitions) &&
        cppComplexNativeSupported(output.node, definitions)
        ? { command, input: input.node, output: output.node }
        : null;
    })
    .filter((entry): entry is CppCommandSets['complexSupported'][number] => entry !== null);
  const staticCommands = [
    ...supported.map((command) => ({ command, route: 'postcard' as const })),
    ...complexSupported.map(({ command }) => ({ command, route: 'complex' as const })),
  ];
  const posCommands = supported
    .map((cmd) => ({ cmd, code: cppEncodePosCommand(cmd, definitions) }))
    .filter((entry): entry is { cmd: CommandSchema; code: string } => entry.code !== null);
  const bufferInputCommands = supported.filter((command) =>
    bufferCommandField(command, definitions),
  );
  const bufferCommands = supported
    .map((cmd) => ({ cmd, output: bufferCommandResultField(cmd, definitions) }))
    .filter((entry): entry is CppCommandSets['bufferCommands'][number] => entry.output !== null);
  const rawCommands = supported
    .map((cmd) => ({ cmd, shape: rawCommandShape(cmd, definitions) }))
    .filter((entry): entry is CppCommandSets['rawCommands'][number] => entry.shape !== null);
  return {
    definitions,
    supported,
    complexSupported,
    staticCommands,
    posCommands,
    bufferInputCommands,
    bufferCommands,
    rawCommands,
  };
}
