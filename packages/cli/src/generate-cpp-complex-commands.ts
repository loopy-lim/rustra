import type { CommandSchema } from './schema.js';
import type { CodecIrNode } from './codec-ir.js';
import { buildCodecIr } from './codec-ir.js';
import { commandFunctionName } from './codegen.js';
import { cppComplexDecodeExpr } from './generate-cpp-complex-decode.js';
import {
  cppComplexDecodeName,
  cppComplexEncodeName,
  type CppComplexState,
} from './generate-cpp-complex-literals.js';
import { cppComplexEncodeNode } from './generate-cpp-complex-encode.js';

export function cppComplexEncodeCommand(command: CommandSchema, input: CodecIrNode): string {
  const fnName = commandFunctionName(command.name);
  const state: CppComplexState = { counter: 0 };
  return (
    [
      `static void encode_complex_${fnName}(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {`,
      `  w.push_u8(${command.commandId & 0xff}); w.push_u8(${(command.commandId >> 8) & 0xff});`,
      ...cppComplexEncodeNode(input, 'args', '  ', '0', state),
      '}',
    ].join('\n') + '\n'
  );
}

export function cppComplexDecodeCommand(command: CommandSchema, output: CodecIrNode): string {
  const fnName = commandFunctionName(command.name);
  const state: CppComplexState = { counter: 0 };
  return (
    [
      `static jsi::Value decode_complex_${fnName}(jsi::Runtime& rt, rc::Reader& r) {`,
      `  return ${cppComplexDecodeExpr(output, '0', state)};`,
      '}',
    ].join('\n') + '\n'
  );
}

export function cppComplexRefFunctions(
  definitions: Record<string, import('./schema.js').JsonSchema>,
  names: Set<string>,
): { declarations: string[]; definitions: string[] } {
  const declarations: string[] = [];
  const bodies: string[] = [];
  for (const name of names) {
    const result = buildCodecIr(definitions[name], definitions);
    if (!result.ok) continue;
    declarations.push(
      `static void ${cppComplexEncodeName(name)}(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);`,
      `static jsi::Value ${cppComplexDecodeName(name)}(jsi::Runtime&, rc::Reader&, size_t);`,
    );
  }
  for (const name of names) {
    const result = buildCodecIr(definitions[name], definitions);
    if (!result.ok) continue;
    const encodeState: CppComplexState = { counter: 0 };
    const decodeState: CppComplexState = { counter: 0 };
    bodies.push(
      `static void ${cppComplexEncodeName(name)}(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");`,
      ...cppComplexEncodeNode(result.node, 'value', '  ', '_depth', encodeState),
      '}',
      `static jsi::Value ${cppComplexDecodeName(name)}(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return ${cppComplexDecodeExpr(result.node, '_depth', decodeState)}; }`,
    );
  }
  return { declarations, definitions: bodies };
}
