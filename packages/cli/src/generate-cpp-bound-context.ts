import { collectPostcardFields } from './generate-postcard-graph.js';
import { cppPropertyNames } from './generate-cpp-properties.js';
import type { CppCommandSets } from './generate-cpp-output-types.js';

/** Runtime handles belong only to the managed HostFunction and synchronous locals. */
export function appendCppBoundContext(lines: string[], sets: CppCommandSets): void {
  lines.push(
    `namespace rustra::generated {`,
    `struct BoundCodecContext {`,
    `  const uint16_t commandId;`,
    `  const std::vector<jsi::PropNameID> input;`,
    `  const std::vector<jsi::PropNameID> output;`,
    `private:`,
    `  static std::vector<jsi::PropNameID> ownNames(Runtime& rt, std::initializer_list<const char*> names) {`,
    `    std::vector<jsi::PropNameID> result; result.reserve(names.size());`,
    `    for (auto name : names) result.push_back(jsi::PropNameID::forAscii(rt, name));`,
    `    return result;`,
    `  }`,
    `  BoundCodecContext(Runtime& rt, uint16_t id, std::initializer_list<const char*> in, std::initializer_list<const char*> out)`,
    `    : commandId(id), input(ownNames(rt, in)), output(ownNames(rt, out)) {}`,
    `  friend std::shared_ptr<const BoundCodecContext> make_bound_codec_context(Runtime&, uint16_t);`,
    `};`,
    `std::shared_ptr<const BoundCodecContext> make_bound_codec_context(Runtime& rt, uint16_t commandId) {`,
    `  switch (commandId) {`,
  );
  for (const { command, route } of sets.staticCommands) {
    const names = (direction: 'inputSchema' | 'outputSchema') =>
      route === 'complex'
        ? ''
        : cppPropertyNames(
            collectPostcardFields(command[direction], sets.definitions).fields,
            sets.definitions,
          )
            .map((name) => JSON.stringify(name))
            .join(', ');
    lines.push(
      `    case ${command.commandId}: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {${names('inputSchema')}}, {${names('outputSchema')}}));`,
    );
  }
  lines.push(
    `    default: throw JSError(rt, "rustra: no bound codec for cmd_id " + std::to_string(commandId));`,
    `  }`,
    `}`,
    `} // namespace rustra::generated`,
    ``,
  );
}
