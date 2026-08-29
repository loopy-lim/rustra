import type { CommandSchema } from './schema.js';
import type { CodecIrNode } from './codec-ir.js';
import type { PostcardField } from './generate-postcard-ir.js';
import type { RawCommandShape } from './generate-cpp-routes.js';

export type StaticCppCommand = { command: CommandSchema; route: 'postcard' | 'complex' };
export type ComplexCppCommand = { command: CommandSchema; input: CodecIrNode; output: CodecIrNode };
export type PosCppCommand = { cmd: CommandSchema; code: string };
export type BufferCppCommand = { cmd: CommandSchema; output: PostcardField };
export type RawCppCommand = { cmd: CommandSchema; shape: RawCommandShape };

export type CppCommandSets = {
  definitions: Record<string, import('./schema.js').JsonSchema>;
  supported: CommandSchema[];
  complexSupported: ComplexCppCommand[];
  staticCommands: StaticCppCommand[];
  posCommands: PosCppCommand[];
  bufferInputCommands: CommandSchema[];
  bufferCommands: BufferCppCommand[];
  rawCommands: RawCppCommand[];
};
