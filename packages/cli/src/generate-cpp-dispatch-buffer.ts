import type { PostcardField } from './generate-postcard-ir.js';
import type { CppCommandSets } from './generate-cpp-output-types.js';

export function appendCppBufferDispatch(lines: string[], sets: CppCommandSets): void {
  const { bufferCommands, bufferInputCommands, rawCommands } = sets;
  lines.push(
    `bool has_buffer_codec(uint16_t cmd_id) {`,
    `  switch (cmd_id) {`,
    bufferCommands.map(({ cmd }) => `    case ${cmd.commandId}: return true;`).join('\n'),
    `    default: return false;`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `void encode_buffer_by_id(uint16_t cmd_id, const uint8_t* data, size_t size, rc::Writer& w) {`,
    `  if (size > 0 && data == nullptr) throw std::invalid_argument("rustra: null byte buffer");`,
    `  switch (cmd_id) {`,
  );
  for (const command of bufferInputCommands)
    lines.push(
      `    case ${command.commandId}:`,
      `      w.push_u8(${command.commandId & 0xff}); w.push_u8(${(command.commandId >> 8) & 0xff});`,
      `      w.push_uvar(size);`,
      `      if (size > 0) w.push_bytes(data, size);`,
      `      return;`,
    );
  lines.push(
    `    default: throw std::invalid_argument("rustra: no buffer codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `Value decode_buffer_result_by_id(Runtime& rt, uint16_t cmd_id, Value buffer) {`,
    `  switch (cmd_id) {`,
  );
  for (const { cmd, output } of bufferCommands)
    lines.push(
      `    case ${cmd.commandId}: {`,
      `      auto result = Object(rt);`,
      `      result.setProperty(rt, cachedProp(rt, "${output.name}"), std::move(buffer));`,
      `      return result;`,
      `    }`,
    );
  lines.push(
    `    default: throw JSError(rt, "rustra: no buffer result codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `bool has_raw_codec(uint16_t cmd_id) {`,
    `  switch (cmd_id) {`,
    rawCommands.map(({ cmd }) => `    case ${cmd.commandId}: return true;`).join('\n'),
    `    default: return false;`,
    `  }`,
    `}`,
    ``,
  );
  appendRawDispatch(lines, rawCommands);
  lines.push(`} // namespace rustra::generated`);
}

function appendRawDispatch(lines: string[], rawCommands: CppCommandSets['rawCommands']): void {
  lines.push(
    `void encode_raw_slots(Runtime& rt, uint16_t cmd_id, const Value* argv, size_t argc, uint64_t* slots) {`,
    `  switch (cmd_id) {`,
  );
  for (const { cmd, shape } of rawCommands) {
    lines.push(
      `    case ${cmd.commandId}: {`,
      `      if (argc != ${shape.inputFields.length}) throw JSError(rt, "rustra: ${cmd.name} expects ${shape.inputFields.length} raw argument(s), got " + std::to_string(argc));`,
    );
    shape.inputFields.forEach((field, index) => appendRawInput(lines, field, index));
    lines.push(`      return;`, `    }`);
  }
  lines.push(
    `    default: throw JSError(rt, "rustra: no raw input codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
  lines.push(
    `Value decode_raw_result(Runtime& rt, uint16_t cmd_id, uint64_t slot) {`,
    `  switch (cmd_id) {`,
  );
  for (const { cmd, shape } of rawCommands) appendRawResult(lines, cmd.commandId, shape);
  lines.push(
    `    default: throw JSError(rt, "rustra: no raw result codec for cmd_id " + std::to_string(cmd_id));`,
    `  }`,
    `}`,
    ``,
  );
}

function appendRawInput(lines: string[], field: PostcardField, index: number): void {
  const name = JSON.stringify(field.name);
  if (field.kind === 'zigzag' || field.kind === 'zigzag64')
    lines.push(
      `      { int64_t value = rustra_i64(rt, argv[${index}], ${name}); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
    );
  else if (field.kind === 'uvar' || field.kind === 'uvar64')
    lines.push(`      slots[${index}] = rustra_u64(rt, argv[${index}], ${name});`);
  else if (field.kind === 'f64')
    lines.push(
      `      { double value = rustra_f64(rt, argv[${index}], ${name}); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
    );
  else if (field.kind === 'f32')
    lines.push(
      `      { double value = static_cast<double>(rustra_f32(rt, argv[${index}], ${name})); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
    );
  else lines.push(`      slots[${index}] = argv[${index}].getBool() ? 1u : 0u;`);
}

function appendRawResult(
  lines: string[],
  commandId: number,
  shape: CppCommandSets['rawCommands'][number]['shape'],
): void {
  lines.push(`    case ${commandId}: {`);
  if (!shape.outputField) lines.push(`      return Value::undefined();`);
  else {
    const field = shape.outputField;
    const name = JSON.stringify(field.name);
    lines.push(`      Object result(rt);`);
    if (field.kind === 'zigzag')
      lines.push(
        `      int64_t value; std::memcpy(&value, &slot, sizeof(value));`,
        `      result.setProperty(rt, cachedProp(rt, ${name}), static_cast<double>(value));`,
      );
    else if (field.kind === 'zigzag64')
      lines.push(
        `      int64_t value; std::memcpy(&value, &slot, sizeof(value));`,
        `      result.setProperty(rt, cachedProp(rt, ${name}), value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));`,
      );
    else if (field.kind === 'uvar')
      lines.push(
        `      result.setProperty(rt, cachedProp(rt, ${name}), static_cast<double>(slot));`,
      );
    else if (field.kind === 'uvar64')
      lines.push(
        `      result.setProperty(rt, cachedProp(rt, ${name}), slot <= 9007199254740991ull ? jsi::Value(static_cast<double>(slot)) : jsi::Value(rt, jsi::BigInt::fromUint64(rt, slot)));`,
      );
    else if (field.kind === 'f64' || field.kind === 'f32')
      lines.push(
        `      double value; std::memcpy(&value, &slot, sizeof(value));`,
        `      result.setProperty(rt, cachedProp(rt, ${name}), value);`,
      );
    else lines.push(`      result.setProperty(rt, cachedProp(rt, ${name}), slot != 0);`);
    lines.push(`      return std::move(result);`);
  }
  lines.push(`    }`);
}
