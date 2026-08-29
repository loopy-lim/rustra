import { cppEncodeCommand } from './generate-cpp-fields.js';
import { cppEncodePosCommand, cppDecodeCommand } from './generate-cpp-routes.js';
import {
  cppComplexDecodeCommand,
  cppComplexEncodeCommand,
  cppComplexRefFunctions,
} from './generate-cpp-complex.js';
import type { CppCommandSets } from './generate-cpp-output-types.js';

export function appendCppGeneratedFunctions(lines: string[], sets: CppCommandSets): void {
  const refs = cppComplexRefFunctions(sets.definitions, new Set(Object.keys(sets.definitions)));
  lines.push(...refs.declarations, ``, ...refs.definitions);
  for (const command of sets.supported) {
    lines.push(cppEncodeCommand(command, sets.definitions));
    const positional = cppEncodePosCommand(command, sets.definitions);
    if (positional) lines.push(positional);
    lines.push(cppDecodeCommand(command, sets.definitions));
  }
  for (const { command, input, output } of sets.complexSupported) {
    lines.push(cppComplexEncodeCommand(command, input), cppComplexDecodeCommand(command, output));
  }
}
