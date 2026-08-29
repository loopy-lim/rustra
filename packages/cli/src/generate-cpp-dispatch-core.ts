import { commandFunctionName } from './codegen.js';
import type { CppCommandSets } from './generate-cpp-output-types.js';

export function appendCppDispatchCore(lines: string[], sets: CppCommandSets): void {
  const { staticCommands, posCommands } = sets;
  const encodeCases = staticCommands
    .map(({ command, route }) => {
      const fn = commandFunctionName(command.name);
      return `  if (name == "${command.name}") { ${route === 'complex' ? 'encode_complex_' : 'encode_'}${fn}(rt, args, w); return true; }`;
    })
    .join('\n');
  const decodeCases = staticCommands
    .map(({ command, route }) => {
      const fn = commandFunctionName(command.name);
      return `  if (name == "${command.name}") return ${route === 'complex' ? 'decode_complex_' : 'decode_'}${fn}(rt, r);`;
    })
    .join('\n');
  const hasCases = staticCommands
    .map(({ command }) => `  if (name == "${command.name}") return true;`)
    .join('\n');
  const encodeIdCases = staticCommands
    .map(
      ({ command, route }) =>
        `    case ${command.commandId}: ${route === 'complex' ? 'encode_complex_' : 'encode_'}${commandFunctionName(command.name)}(rt, args, w); return true;`,
    )
    .join('\n');
  const decodeIdCases = staticCommands
    .map(
      ({ command, route }) =>
        `    case ${command.commandId}: return ${route === 'complex' ? 'decode_complex_' : 'decode_'}${commandFunctionName(command.name)}(rt, r);`,
    )
    .join('\n');
  const staticIdCases = staticCommands
    .map(({ command }) => `    case ${command.commandId}: return true;`)
    .join('\n');
  lines.push(`namespace rustra::generated {`, ``);
  lines.push(
    `bool encode_by_name(Runtime& rt, const std::string& name, const Value& args, rc::Writer& w) {`,
    encodeCases,
    `  return false; // 동적 명령 — JS 가 Tier 3 fallback 처리`,
    `}`,
    ``,
  );
  lines.push(
    `Value decode_by_name(Runtime& rt, const std::string& name, rc::Reader& r) {`,
    decodeCases,
    `  throw JSError(rt, "rustra: no C++ codec for '" + name + "'");`,
    `}`,
    ``,
  );
  lines.push(
    `bool encode_by_id(Runtime& rt, uint16_t cmd_id, const Value& args, rc::Writer& w) {`,
    `  switch (cmd_id) {`,
    encodeIdCases,
    `    default: return false; // 동적/알 수 없는 cmd_id — JS 가 Tier 3 fallback 처리`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `Value decode_by_id(Runtime& rt, uint16_t cmd_id, rc::Reader& r) {`,
    `  switch (cmd_id) {`,
    decodeIdCases,
    `    default: throw JSError(rt, "rustra: no C++ codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `bool has_static_codec(const std::string& name) {`,
    hasCases,
    `  return false;`,
    `}`,
    ``,
  );
  lines.push(
    `bool has_static_codec_id(uint16_t cmd_id) {`,
    `  switch (cmd_id) {`,
    staticIdCases,
    `    default: return false;`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `/// (Tier 1) positional 인자를 직접 인코딩 가능한 cmd_id 집합 — JS 폴백 판별용.`,
    `bool has_pos_codec(uint16_t cmd_id) {`,
    posCommands.map(({ cmd }) => `  if (cmd_id == ${cmd.commandId}) return true;`).join('\n'),
    `  return false;`,
    `}`,
    ``,
  );
  lines.push(
    `/// (Tier 1) 개별 Value 인자 → postcard 바이트. 명령별 코덱이 argc를 정확히 검증한다.`,
    `void encode_pos_by_id(jsi::Runtime& rt, uint16_t cmd_id, const jsi::Value* argv, size_t argc, rc::Writer& w) {`,
    `  switch (cmd_id) {`,
    posCommands
      .map(
        ({ cmd }) =>
          `    case ${cmd.commandId}: encode_pos_${commandFunctionName(cmd.name)}(rt, argv, argc, w); return;`,
      )
      .join('\n'),
    `    default: throw JSError(rt, "rustra: no positional codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
}
