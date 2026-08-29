import type { CommandSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { collectPostcardFields, type PostcardField } from './generate-postcard-ir.js';
import { cppEncodeWithGetter, cppFieldDecodeExpr } from './generate-cpp-fields.js';
import { bufferCommandField, generatedFieldRoute, RAW_SCALAR_KINDS } from './generate-routing.js';

export function bufferCommandResultField(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField | null {
  if (!bufferCommandField(command, definitions)) return null;
  const { fields } = collectPostcardFields(command.outputSchema, definitions);
  const properties = command.outputSchema.properties;
  const required = command.outputSchema.required;
  return fields.length === 1 &&
    fields[0].kind === 'bytes' &&
    properties &&
    Object.keys(properties).length === 1 &&
    Array.isArray(required) &&
    required.length === 1 &&
    required[0] === fields[0].name
    ? fields[0]
    : null;
}

export type RawCommandShape = {
  inputFields: PostcardField[];
  outputField?: PostcardField;
};

/** Mirrors the Rust raw-handler eligibility contract for generated metadata. */
export function rawCommandShape(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): RawCommandShape | null {
  const inputFields = generatedFieldRoute(command, definitions);
  if (!inputFields) return null;
  const rawKinds = new Set<string>(RAW_SCALAR_KINDS);
  if (!inputFields.every((field) => rawKinds.has(field.kind))) return null;
  const { fields: outputFields } = collectPostcardFields(command.outputSchema, definitions);
  if (outputFields.length > 1) return null;
  if (outputFields.length === 0 && command.outputType !== '()') return null;
  if (outputFields.length === 1 && !rawKinds.has(outputFields[0].kind)) return null;
  return { inputFields, outputField: outputFields[0] };
}

/**
 * (Tier 1) positional C++ encode 변형 — JS 인자 객체/프로퍼티 조회 없이
 * HostFunction 의 개별 Value 인자에서 직접 Writer 에 기록한다.
 * 조건: 필드가 3개 이하 + 스칼라(POSITIONAL_SCALAR_KINDS)만 —
 * 배열/구조체 인자는 여전히 객체 경유가 자연스럽다.
 * 산출 바이트는 encode_${fnName} 과 항상 동일(와이어 불변).
 */
export function cppEncodePosCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string | null {
  const fnName = commandFunctionName(command.name);
  const fields = generatedFieldRoute(command, definitions);
  if (!fields) return null;

  const id = command.commandId;
  const lines: string[] = [];
  lines.push(
    `// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 ${fields.length}회 제거.`,
  );
  lines.push(
    `static void encode_pos_${fnName}(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {`,
  );
  lines.push(
    `  if (argc != ${fields.length}) throw jsi::JSError(rt, "rustra: ${command.name} expects ${fields.length} positional argument(s), got " + std::to_string(argc));`,
  );
  lines.push(`  w.push_u8(${id & 0xff}); w.push_u8(${(id >> 8) & 0xff}); // cmd_id = ${id} LE`);
  fields.forEach((f, i) => {
    const v = `argv[${i}]`;
    switch (f.kind) {
      case 'zigzag':
      case 'zigzag64':
        lines.push(`  w.push_i64(rustra_i64(rt, ${v}, "${f.name}"));`);
        break;
      case 'uvar':
      case 'uvar64':
        lines.push(`  w.push_uvar(rustra_u64(rt, ${v}, "${f.name}"));`);
        break;
      case 'f64':
        lines.push(`  w.push_f64(rustra_f64(rt, ${v}, "${f.name}"));`);
        break;
      case 'f32':
        lines.push(`  w.push_f32(rustra_f32(rt, ${v}, "${f.name}"));`);
        break;
      case 'bool':
        lines.push(`  w.push_bool(${v}.asBool());`);
        break;
      case 'string':
        lines.push(`  { auto _s = ${v}.asString(rt).utf8(rt); w.push_string(_s); }`);
        break;
      case 'enum_str': {
        const variants = f.enumVariants ?? [];
        const variantsCpp = `{${variants.map((variant) => JSON.stringify(variant)).join(',')}}`;
        lines.push(
          `  { auto _s = ${v}.asString(rt).utf8(rt); const char* _variants[] = ${variantsCpp}; int _idx = -1; for (int _i = 0; _i < ${variants.length}; _i++) { if (_s == _variants[_i]) { _idx = _i; break; } } if (_idx < 0) throw jsi::JSError(rt, "invalid enum value for ${f.name}"); w.push_uvar((uint32_t)_idx); }`,
        );
        break;
      }
      case 'bytes':
        lines.push(cppEncodeWithGetter(f, v, definitions, '  '));
        break;
      default:
        break;
    }
  });
  lines.push(`}`);
  return lines.join('\n') + '\n';
}

/** 명령 하나의 C++ decode 함수: Reader(postcard body) → JSI Object. */
export function cppDecodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const { fields: outFields } = collectPostcardFields(command.outputSchema, definitions);
  const lines: string[] = [];
  lines.push(`static jsi::Value decode_${fnName}(jsi::Runtime& rt, rc::Reader& r) {`);
  lines.push(`  auto resultObj = jsi::Object(rt);`);
  for (const f of outFields) {
    lines.push(cppFieldDecodeExpr(f, 'resultObj', definitions, '  '));
  }
  lines.push(`  return std::move(resultObj);`);
  lines.push(`}`);
  return lines.join('\n') + '\n';
}
