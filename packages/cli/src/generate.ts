/**
 * @rustra/cli — TypeScript 코드 생성기
 *
 * rustra 패키지 스키마에서 TypeScript 타입 정의, 명령 헬퍼 함수,
 * 계약 해시 파일을 생성합니다.
 */

import { createHash } from 'node:crypto';
import type { CommandSchema, PackageSchema } from './schema.js';
import {
  collectDefinitions,
  commandFunctionName,
  postcardHelperSource,
  tsTypeFromSchema,
} from './codegen.js';

/**
 * 패키지 스키마에서 TypeScript 타입 정의 파일(`types.ts`)을 생성합니다.
 */
export function generateTypesTs(schema: PackageSchema): string {
  let output =
    "export type { EngineClient, RustraError } from '@rustra/types';\n" +
    "export { RustraCommandError } from '@rustra/types';\n\n";

  const allDefinitions: Record<string, import('./schema.js').JsonSchema> = {};
  for (const command of schema.commands) {
    if (command.definitions) {
      for (const [key, value] of Object.entries(command.definitions)) {
        allDefinitions[key] = value;
      }
    }
    collectDefinitions(command.inputSchema, allDefinitions);
    collectDefinitions(command.outputSchema, allDefinitions);
  }

  const emitted = new Set<string>();

  for (const [name, defSchema] of Object.entries(allDefinitions)) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  for (const command of schema.commands) {
    if (!emitted.has(command.inputType)) {
      emitted.add(command.inputType);
      output += `export type ${command.inputType} = ${tsTypeFromSchema(command.inputSchema, allDefinitions)};\n\n`;
    }
    // unit 출력 타입 `()` 은 TS 타입명으로 쓸 수 없다 — Promise<void> 로 표현.
    if (command.outputType !== '()' && !emitted.has(command.outputType)) {
      emitted.add(command.outputType);
      output += `export type ${command.outputType} = ${tsTypeFromSchema(command.outputSchema, allDefinitions)};\n\n`;
    }
  }

  return output;
}

/**
 * 패키지 스키마에서 TypeScript 명령 헬퍼 함수 파일(`commands.ts`)을 생성합니다.
 *
 * Tauri-like 글로벌 invoke 패턴: `configure()`로 엔진을 한 번 설정하면
 * 이후 `addNumbers({ a: 42 })`로 engine 파라미터 없이 호출 가능합니다.
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const typeNames = new Set<string>();
  for (const command of schema.commands) {
    typeNames.add(command.inputType);
    typeNames.add(command.outputType);
  }
  // unit 타입 `()` (예: Result<()> 반환 command) 은 import 대상이 아니다.
  typeNames.delete('()');

  const imports = Array.from(typeNames).sort().join(', ');
  let output = `import type { ${imports} } from './types.js';\n`;
  output += `import { invoke } from '@rustra/types';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    // unit 출력 `()` → Promise<void>.
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    output +=
      `export function ${fnName}(input: ${command.inputType}): Promise<${outType}> {\n` +
      `  return invoke<${outType}>('${command.name}', input);\n` +
      `}\n\n`;
  }

  return output;
}

/**
 * 스키마 JSON에서 계약 해시 파일(`contract.ts`)을 생성합니다.
 */
export function generateContractTs(schemaJson: string): string {
  const hash = createHash('sha256').update(schemaJson).digest('hex');
  return `export const GENERATED_CONTRACT_HASH = '${hash}';\n`;
}

// ── rkyv V2 codec generation (postcard wire format) ────────────────────

/** Postcard field types for schema classification. */
type PostcardFieldKind =
  | 'zigzag'
  | 'f64'
  | 'f32'
  | 'bool'
  | 'string'
  | 'vec_zigzag'
  | 'vec_f64'
  | 'vec_bool'
  | 'set_zigzag'
  | 'set_f64'
  | 'set_bool'
  | 'struct'; // nested struct via $ref; set_* = Set (wire-compatible with vec)

type PostcardField = {
  name: string;
  kind: PostcardFieldKind;
  /** For struct fields: the resolved type name from $ref */
  refType?: string;
};

/**
 * Classify a single JSON Schema property into its postcard wire encoding kind.
 */
function classifyPostcardField(schema: import('./schema.js').JsonSchema): PostcardFieldKind | null {
  if (schema.$ref) return 'struct';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'integer') return 'zigzag';
  if (schema.type === 'number') {
    if (schema.format === 'float') return 'f32';
    return 'f64';
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = schema.items;
    // `uniqueItems`(Set)도 와이어포맷은 배열과 동일 — 인코딩 시 `[...value]`로
    // 평탄화, 디코딩 시 `new Set(...)`로 복원 (postcard Vec와 byte 호환).
    if (items.type === 'integer') return schema.uniqueItems ? 'set_zigzag' : 'vec_zigzag';
    if (items.type === 'number') return schema.uniqueItems ? 'set_f64' : 'vec_f64';
    if (items.type === 'boolean') return schema.uniqueItems ? 'set_bool' : 'vec_bool';
    return null;
  }
  return null;
}

/**
 * Collect all fields for a schema in property order (as they appear in the JSON schema).
 *
 * Schemars generates properties alphabetically. Postcard encodes in struct definition
 * order. For the calculator example, this ordering matches because Rust struct fields
 * happen to be in the same order as alphabetical. If ordering issues arise in the
 * future, the schema generator needs to preserve definition order.
 */
function collectPostcardFields(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField[] {
  const props = schema.properties;
  if (!props) return [];
  const required = new Set(schema.required ?? []);
  const fields: PostcardField[] = [];

  for (const [name, propSchema] of Object.entries(props)) {
    if (!required.has(name)) continue;
    const kind = classifyPostcardField(propSchema);
    if (!kind) continue;
    const field: PostcardField = { name, kind };
    if (kind === 'struct' && propSchema.$ref) {
      field.refType = propSchema.$ref.startsWith('#/definitions/')
        ? propSchema.$ref.slice('#/definitions/'.length)
        : propSchema.$ref;
    }
    fields.push(field);
  }
  return fields;
}

/**
 * Collect all definitions from the schema tree.
 * These come from both command-level definitions and schema-level definitions.
 */
function collectAllDefinitions(
  schema: PackageSchema,
): Record<string, import('./schema.js').JsonSchema> {
  const defs: Record<string, import('./schema.js').JsonSchema> = {};
  for (const command of schema.commands) {
    // Command-level definitions (from schemars $ref targets)
    if (command.definitions) {
      Object.assign(defs, command.definitions);
    }
    // Schema-level definitions (nested inside inputSchema/outputSchema)
    if (command.inputSchema.definitions) {
      Object.assign(defs, command.inputSchema.definitions);
    }
    if (command.outputSchema.definitions) {
      Object.assign(defs, command.outputSchema.definitions);
    }
  }
  return defs;
}

/**
 * Generate the postcard encode expression for a single field value.
 * Returns code lines that push Uint8Array parts into a `parts` array.
 */
function generateFieldEncodeExpr(
  field: PostcardField,
  valueExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  switch (field.kind) {
    case 'zigzag':
      return `${indent}parts.push(_pcEncodeZigzagVarint(${valueExpr}));`;
    case 'f64':
      return `${indent}parts.push(_pcEncodeF64(${valueExpr}));`;
    case 'f32':
      return `${indent}parts.push(_pcEncodeF32(${valueExpr}));`;
    case 'bool':
      return `${indent}parts.push(new Uint8Array([${valueExpr} ? 1 : 0]));`;
    case 'string':
      return `${indent}parts.push(_pcEncodeString(${valueExpr}));`;
    case 'vec_zigzag':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeZigzagVarint(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_f64':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeF64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_bool':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(new Uint8Array([_arr[_i] ? 1 : 0]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'set_zigzag':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeZigzagVarint(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'set_f64':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeF64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'set_bool':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(new Uint8Array([_arr[_i] ? 1 : 0]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const subFields = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      for (const sf of subFields) {
        lines.push(generateFieldEncodeExpr(sf, `${valueExpr}.${sf.name}`, definitions, indent));
      }
      return lines.join('\n');
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/**
 * Generate the postcard decode expression for a single field.
 * Returns code lines that decode from `u8` starting at `offset`.
 */
function generateFieldDecodeExpr(
  field: PostcardField,
  lvalue: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  switch (field.kind) {
    case 'zigzag':
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeZigzagVarint(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'f64':
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeF64(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'f32':
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeF32(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'bool':
      return (
        `${indent}{\n` +
        `${indent}  ${lvalue} = u8[offset] === 1;\n` +
        `${indent}  offset += 1;\n` +
        `${indent}}`
      );
    case 'string':
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeString(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'vec_zigzag':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: number[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeZigzagVarint(u8, offset);\n` +
        `${indent}    _arr[_i] = _v.value;\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _arr;\n` +
        `${indent}}`
      );
    case 'vec_f64':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: number[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeF64(u8, offset);\n` +
        `${indent}    _arr[_i] = _v.value;\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _arr;\n` +
        `${indent}}`
      );
    case 'vec_bool':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: boolean[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    _arr[_i] = u8[offset] === 1;\n` +
        `${indent}    offset += 1;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _arr;\n` +
        `${indent}}`
      );
    case 'set_zigzag':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<number>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeZigzagVarint(u8, offset);\n` +
        `${indent}    _set.add(_v.value);\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _set;\n` +
        `${indent}}`
      );
    case 'set_f64':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<number>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeF64(u8, offset);\n` +
        `${indent}    _set.add(_v.value);\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _set;\n` +
        `${indent}}`
      );
    case 'set_bool':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<boolean>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    _set.add(u8[offset] === 1);\n` +
        `${indent}    offset += 1;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _set;\n` +
        `${indent}}`
      );
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const subFields = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{`);
      lines.push(`${indent}  const _obj: ${field.refType} = {} as ${field.refType};`);
      for (const sf of subFields) {
        lines.push(generateFieldDecodeExpr(sf, `_obj.${sf.name}`, definitions, `${indent}  `));
      }
      lines.push(`${indent}  ${lvalue} = _obj;`);
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/**
 * 패키지 스키마에서 rkyv V2 코덱 파일(`rkyv-codecs.ts`)을 생성합니다.
 *
 * 모든 명령은 postcard wire format을 사용합니다:
 * - Request:  `[cmd_id: u16 LE @0][postcard(Input) @2...]`
 * - Response: `[ok: u8 @0][pad 7B][postcard(Output) @8...]`
 * - Error:    `[ok: u8 @0 = 0][pad 7B][error_len: u16 @8 LE][error_bytes @10...]`
 */
export function generateRkyvCodecsTs(schema: PackageSchema): string {
  const allTypes = schema.commands
    .flatMap((c) => [c.inputType, c.outputType])
    // unit 타입 `()` (예: Result<()> 반환 command) 은 import 대상이 아니다.
    .filter((t) => t !== '()')
    .filter((v, i, a) => a.indexOf(v) === i);

  const definitions = collectAllDefinitions(schema);

  // Include definition types (e.g. Item) referenced by struct fields in codecs
  const definitionTypes = Object.keys(definitions);
  const importTypes = [...new Set([...allTypes, ...definitionTypes])].sort();

  let output = postcardHelperSource();

  output += "import type { RkyvV2Codec, RustraError } from '@rustra/types';\n";
  output += `import type { ${importTypes.join(', ')} } from './types.js';\n\n`;

  for (const command of schema.commands) {
    output += generatePostcardCodec(command, definitions);
  }

  return output;
}

/**
 * Generate a single postcard-based codec for a command.
 */
function generatePostcardCodec(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  // unit 출력 `()` → void. postcard 와이어 상 unit 은 0바이트(outFields 자연히 빈 배열).
  const outType = command.outputType === '()' ? 'void' : command.outputType;
  const inFields = collectPostcardFields(command.inputSchema, definitions);
  const outFields = collectPostcardFields(command.outputSchema, definitions);

  const lines: string[] = [];

  lines.push(`export const ${fnName}Codec: RkyvV2Codec<${inType}, ${outType}> = {`);
  lines.push(`  commandId: ${command.commandId},`);

  // ── encode ──
  lines.push('');
  lines.push(`  encode(args: ${inType}): ArrayBuffer {`);
  lines.push(`    // [cmd_id: u16 LE][postcard(${inType})]`);
  lines.push(`    const parts: Uint8Array[] = [];`);
  lines.push(`    const cmdId = new Uint8Array(2);`);
  lines.push(`    new DataView(cmdId.buffer).setUint16(0, ${command.commandId}, true);`);
  lines.push(`    parts.push(cmdId);`);

  // Encode each input field in postcard format
  for (const field of inFields) {
    lines.push(generateFieldEncodeExpr(field, `args.${field.name}`, definitions, '    '));
  }

  lines.push(`    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;`);
  lines.push(`  },`);

  // ── decode ──
  lines.push('');
  lines.push(
    `  decode(buf: ArrayBuffer): { ok: boolean; result?: ${outType}; error?: RustraError } {`,
  );
  lines.push(
    `    if (buf.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };`,
  );
  lines.push(`    const u8 = new Uint8Array(buf);`);
  lines.push(`    const view = new DataView(buf);`);
  lines.push(`    if (u8[0] !== 1) {`);
  lines.push(`      const errLen = view.getUint16(8, true);`);
  lines.push(`      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };`);
  lines.push(`      if (errLen > 0) {`);
  lines.push(`        // postcard({ code: String, message: String })`);
  lines.push(`        const c = _pcDecodeString(u8, 10);`);
  lines.push(`        const m = _pcDecodeString(u8, 10 + c.bytesRead);`);
  lines.push(`        err = { code: c.value, message: m.value };`);
  lines.push(`      }`);
  lines.push(`      return { ok: false, error: err };`);
  lines.push(`    }`);

  if (outFields.length === 0) {
    lines.push(`    return { ok: true, result: {} as ${outType} };`);
  } else {
    lines.push(`    // Decode postcard from offset 8`);
    lines.push(`    let offset = 8;`);
    lines.push(`    const result: Partial<${outType}> = {};`);
    for (const field of outFields) {
      lines.push(generateFieldDecodeExpr(field, `result.${field.name}`, definitions, '    '));
    }
    lines.push(`    return { ok: true, result: result as ${outType} };`);
  }

  lines.push(`  },`);
  lines.push(`};`);
  lines.push('');

  return lines.join('\n') + '\n';
}

/**
 * 패키지 스키마에서 rkyv V2 레지스트리 파일(`rkyv-registry.ts`)을 생성합니다.
 */
export function generateRkyvRegistryTs(schema: PackageSchema): string {
  const included = schema.commands;

  const entries = included
    .map((c) => {
      const fnName = commandFunctionName(c.name);
      return `  ['${c.name}', ${fnName}Codec]`;
    })
    .join(',\n');

  const codecImports = included.map((c) => commandFunctionName(c.name) + 'Codec').join(', ');

  return (
    `import { ${codecImports} } from './rkyv-codecs.js';\n\n` +
    `export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([\n` +
    entries +
    `,\n]);\n`
  );
}

// ── C++ codec generation (postcard wire + JSI marshal) ──────────────────
//
// TS codec(`rkyv-codecs.ts`)와 동일한 postcard 로직을 C++ 로 방출한다.
// RN(React Native) JSI 경로가 이 C++ codec 을 사용해 JS↔native 변환을
// native 스레드에서 수행한다(JS-side codec ~3.4µs 제거).
// 와이어 포맷·Rust FFI·응답 헤더는 TS 경로와 동일(불변).

/** C++ postcard encode: JSI Object 필드 → Writer. <objExpr>는 jsi::Object. */
function cppFieldEncodeExpr(
  field: PostcardField,
  objExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  const get = `${objExpr}.getProperty(rt, "${field.name}")`;
  switch (field.kind) {
    case 'zigzag':
      return `${indent}{ auto _v = ${get}.asNumber(); w.push_i64((int64_t)_v); }`;
    case 'f64':
      return `${indent}{ auto _v = ${get}.asNumber(); w.push_f64(_v); }`;
    case 'f32':
      return `${indent}{ auto _v = ${get}.asNumber(); w.push_f32((float)_v); }`;
    case 'bool':
      return `${indent}{ auto _v = ${get}.getBool(); w.push_bool(_v); }`;
    case 'string':
      return `${indent}{ auto _v = ${get}.getString(rt).utf8(rt); w.push_string(_v); }`;
    case 'vec_zigzag':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).asNumber(); w.push_i64((int64_t)_e); } }`
      );
    case 'vec_f64':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).asNumber(); w.push_f64(_e); } }`
      );
    case 'vec_bool':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).getBool(); w.push_bool(_e); } }`
      );
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const subObj = `${get}.asObject(rt)`;
      const subFields = collectPostcardFields(structDef, definitions);
      return subFields.map((sf) => cppFieldEncodeExpr(sf, subObj, definitions, indent)).join('\n');
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/** C++ postcard decode: Reader → JSI Object 필드 setProperty. <objExpr>는 jsi::Object. */
function cppFieldDecodeExpr(
  field: PostcardField,
  objExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  const setProp = (val: string) => `${indent}${objExpr}.setProperty(rt, "${field.name}", ${val});`;
  switch (field.kind) {
    case 'zigzag':
      return setProp('(double)r.read_i64()');
    case 'f64':
      return setProp('r.read_f64()');
    case 'f32':
      return setProp('(double)r.read_f32()');
    case 'bool':
      return setProp('r.read_bool()');
    case 'string':
      return (
        `${indent}{ auto _s = r.read_string();` +
        ` ${objExpr}.setProperty(rt, "${field.name}", jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_s.data()), _s.size())); }`
      );
    case 'vec_zigzag':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, (double)r.read_i64()); }` +
        ` ${objExpr}.setProperty(rt, "${field.name}", _arr); }`
      );
    case 'vec_f64':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_f64()); }` +
        ` ${objExpr}.setProperty(rt, "${field.name}", _arr); }`
      );
    case 'vec_bool':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_bool()); }` +
        ` ${objExpr}.setProperty(rt, "${field.name}", _arr); }`
      );
    case 'struct': {
      if (!field.refType) return `${indent}// unknown struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const subFields = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{ auto _obj = jsi::Object(rt);`);
      for (const sf of subFields) {
        lines.push(cppFieldDecodeExpr(sf, '_obj', definitions, `${indent}  `));
      }
      lines.push(`${indent}  ${objExpr}.setProperty(rt, "${field.name}", _obj); }`);
      return lines.join('\n');
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/** 명령 하나의 C++ encode 함수: [cmd_id u16 LE][postcard(Input)] 을 Writer 에 기록. */
function cppEncodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const inFields = collectPostcardFields(command.inputSchema, definitions);
  const id = command.commandId;
  const lines: string[] = [];
  lines.push(
    `static void encode_${fnName}(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {`,
  );
  lines.push(`  w.push_u8(${id & 0xff}); w.push_u8(${(id >> 8) & 0xff}); // cmd_id = ${id} LE`);
  lines.push(`  auto argsObj = args.asObject(rt);`);
  for (const f of inFields) {
    lines.push(cppFieldEncodeExpr(f, 'argsObj', definitions, '  '));
  }
  lines.push(`}`);
  return lines.join('\n') + '\n';
}

/** 명령 하나의 C++ decode 함수: Reader(postcard body) → JSI Object. */
function cppDecodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const outFields = collectPostcardFields(command.outputSchema, definitions);
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

/**
 * 패키지 스키마에서 C++ codec 헤더(`rustra-generated-codecs.hpp`)를 생성한다.
 * RN JSI bridge(RustraJSIBridge.cpp)가 include 하여 encode_by_name/decode_by_name 호출.
 */
export function generateRkyvCodecsHpp(schema: PackageSchema): string {
  return (
    `// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.\n` +
    `// C++ postcard codec for the RN JSI fast path (B1).\n` +
    `// 정적 명령: C++ codec 으로 postcard 인코딩/디코딩. 동적 명령은 JS Tier 3 fallback.\n` +
    `#pragma once\n\n` +
    `#include <jsi/jsi.h>\n` +
    `#include <string>\n` +
    `#include "rustra-codec.hpp"\n\n` +
    `namespace rustra::generated {\n\n` +
    `/// 명령 이름으로 postcard 요청 바이트를 인코딩한다(정적 명령만).\n` +
    `/// 인코딩 성공(정적 명령) 시 true, 미발견(동적 명령) 시 false.\n` +
    `bool encode_by_name(facebook::jsi::Runtime& rt, const std::string& name,\n` +
    `                   const facebook::jsi::Value& args,\n` +
    `                   rustra::codec::Writer& w);\n\n` +
    `/// 명령 이름으로 postcard 응답 바디를 디코딩한다(정적 명령만).\n` +
    `/// 미발견 시 JSError throw.\n` +
    `facebook::jsi::Value decode_by_name(facebook::jsi::Runtime& rt,\n` +
    `                                   const std::string& name,\n` +
    `                                   rustra::codec::Reader& r);\n\n` +
    `/// codegen 시점에 알려진 정적 명령 이름 집합(Tier 3 fallback 분기용).\n` +
    `bool has_static_codec(const std::string& name);\n\n` +
    `} // namespace rustra::generated\n`
  );
}

/**
 * 패키지 스키마에서 C++ codec 구현(`rustra-generated-codecs.cpp`)을 생성한다.
 */
export function generateRkyvCodecsCpp(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const fns = schema.commands.map((c) => commandFunctionName(c.name));
  const encodeCases = fns
    .map((fn) => `  if (name == "${fn}") { encode_${fn}(rt, args, w); return true; }`)
    .join('\n');
  const decodeCases = fns
    .map((fn) => `  if (name == "${fn}") return decode_${fn}(rt, r);`)
    .join('\n');
  const hasCases = fns.map((fn) => `  if (name == "${fn}") return true;`).join('\n');

  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.`);
  lines.push(`// C++ postcard codec for the RN JSI fast path (B1).`);
  lines.push(`#include "rustra-generated-codecs.hpp"`);
  lines.push(`#include <jsi/jsi.h>`);
  lines.push(`#include <string>`);
  lines.push(``);
  lines.push(`using namespace facebook::jsi;`);
  lines.push(`namespace rc = rustra::codec;`);
  lines.push(``);
  for (const command of schema.commands) {
    lines.push(cppEncodeCommand(command, definitions));
    lines.push(cppDecodeCommand(command, definitions));
  }
  lines.push(`namespace rustra::generated {`);
  lines.push(``);
  lines.push(
    `bool encode_by_name(Runtime& rt, const std::string& name, const Value& args, rc::Writer& w) {`,
  );
  lines.push(encodeCases);
  lines.push(`  return false; // 동적 명령 — JS 가 Tier 3 fallback 처리`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Value decode_by_name(Runtime& rt, const std::string& name, rc::Reader& r) {`);
  lines.push(decodeCases);
  lines.push(`  throw JSError(rt, "rustra: no C++ codec for '" + name + "'");`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`bool has_static_codec(const std::string& name) {`);
  lines.push(hasCases);
  lines.push(`  return false;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`} // namespace rustra::generated`);
  return lines.join('\n') + '\n';
}
