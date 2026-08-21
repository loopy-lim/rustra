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
  escapeJsDoc,
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
    if (typeof defSchema.description === 'string') {
      output += `/**\n * ${escapeJsDoc(defSchema.description).replace(/\n/g, '\n * ')}\n */\n`;
    }
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  for (const command of schema.commands) {
    if (command.inputType !== '()' && !emitted.has(command.inputType)) {
      emitted.add(command.inputType);
      if (typeof command.inputSchema.description === 'string') {
        output += `/**\n * ${escapeJsDoc(command.inputSchema.description).replace(/\n/g, '\n * ')}\n */\n`;
      }
      output += `export type ${command.inputType} = ${tsTypeFromSchema(command.inputSchema, allDefinitions)};\n\n`;
    }
    // unit 출력 타입 `()` 은 TS 타입명으로 쓸 수 없다 — Promise<void> 로 표현.
    if (command.outputType !== '()' && !emitted.has(command.outputType)) {
      emitted.add(command.outputType);
      if (typeof command.outputSchema.description === 'string') {
        output += `/**\n * ${escapeJsDoc(command.outputSchema.description).replace(/\n/g, '\n * ')}\n */\n`;
      }
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
    if (command.inputType !== '()') typeNames.add(command.inputType);
    if (command.outputType !== '()') typeNames.add(command.outputType);
  }

  const imports = Array.from(typeNames).sort().join(', ');
  let output = '';
  if (imports.length > 0) {
    output += `import type { ${imports} } from './types.js';\n`;
  }
  output += `import { invoke } from '@rustra/types';\n`;
  output += `import type { InvokeOptions } from '@rustra/types';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    // unit 출력 `()` → Promise<void>.
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    if (typeof command.inputSchema?.description === 'string') {
      output += `/**\n * ${escapeJsDoc(command.inputSchema.description).replace(/\n/g, '\n * ')}\n */\n`;
    }
    if (command.inputType === '()') {
      output +=
        `export function ${fnName}(options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invoke<${outType}>('${command.name}', undefined, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    } else {
      output +=
        `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invoke<${outType}>('${command.name}', input, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    }
  }

  return output;
}

/**
 * 스키마 JSON에서 계약 해시 파일(`contract.ts`)을 생성합니다.
 *
 * (T2, OTA) 스키마의 `schemaVersion` 을 `SCHEMA_VERSION` 상수로 함께 노출한다 —
 * Rust 코드젠(`GeneratedPackage::contract_ts`)과 동일한 형식이며, JS 클라이언트가
 * 네이티브 live schema 의 버전과 비교해 JS > native stale 를 감지하는 데 쓰인다.
 * 필드가 없는 구 스키마는 1 로 취급한다.
 */
export function generateContractTs(schemaJson: string): string {
  const hash = createHash('sha256').update(schemaJson).digest('hex');
  let schemaVersion = 1;
  try {
    const parsed: unknown = JSON.parse(schemaJson);
    if (parsed !== null && typeof parsed === 'object' && 'schemaVersion' in parsed) {
      const v = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (typeof v === 'number' && Number.isFinite(v)) schemaVersion = v;
    }
  } catch {
    // 스키마 파싱 실패 시에도 해시는 유효 — 버전만 기본값을 유지한다.
  }
  return (
    `export const GENERATED_CONTRACT_HASH = '${hash}';\n` +
    `export const SCHEMA_VERSION = ${schemaVersion};\n`
  );
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
  | 'struct' // nested struct via $ref; set_* = Set (wire-compatible with vec)
  | 'vec_string'
  | 'vec_struct'
  | 'option_zigzag'
  | 'option_f64'
  | 'option_f32'
  | 'option_bool'
  | 'option_string'
  | 'option_struct'
  | 'enum_str'; // string-only enum (postcard: variant index varint)

type PostcardField = {
  name: string;
  kind: PostcardFieldKind;
  /** For struct fields: the resolved type name from $ref */
  refType?: string;
  /** For enum_str fields: variant values in declaration order (postcard index) */
  enumVariants?: string[];
};

/**
 * Classify a single JSON Schema property into its postcard wire encoding kind.
 *
 * Wire 계약 (Rust typed postcard 핸들러 — `Command::rkyv_v2_handler` 와 일치):
 * - `Option<T>`: 태그 바이트(0=None/1=Some) + 값
 * - `Vec<T>`: varint 길이 + 요소들
 * - string enum: variant index varint (postcard enum 표현)
 */
function classifyPostcardField(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardFieldKind | null {
  // string-only enum — postcard는 variant index varint로 직렬화한다.
  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allStrings = schema.enum.every((v) => typeof v === 'string');
    if (allStrings) return 'enum_str';
  }
  if (schema.$ref) return 'struct';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'integer') return 'zigzag';
  if (schema.type === 'number') {
    if (schema.format === 'float') return 'f32';
    return 'f64';
  }
  if (schema.type === 'string') return 'string';
  // `Option<T>` — schemars는 `type: ["T","null"]` 또는 `anyOf: [T, null]`로 내보낸다.
  const optionInner = unwrapOptionSchema(schema, definitions);
  if (optionInner) {
    const inner = classifyPostcardField(optionInner, definitions);
    if (inner === null) return null;
    if (inner === 'zigzag') return 'option_zigzag';
    if (inner === 'f64') return 'option_f64';
    if (inner === 'f32') return 'option_f32';
    if (inner === 'bool') return 'option_bool';
    if (inner === 'string') return 'option_string';
    if (inner === 'struct') return 'option_struct';
    // enum_str/vec/set 등 조합은 아직 미지원 — Tier 3 제외 대상
    return null;
  }
  if (schema.type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = schema.items;
    // `uniqueItems`(Set)도 와이어포맷은 배열과 동일 — 인코딩 시 `[...value]`로
    // 평탄화, 디코딩 시 `new Set(...)`로 복원 (postcard Vec와 byte 호환).
    if (items.type === 'integer') return schema.uniqueItems ? 'set_zigzag' : 'vec_zigzag';
    if (items.type === 'number') return schema.uniqueItems ? 'set_f64' : 'vec_f64';
    if (items.type === 'boolean') return schema.uniqueItems ? 'set_bool' : 'vec_bool';
    if (items.type === 'string') return 'vec_string';
    if (items.$ref) return 'vec_struct';
    return null;
  }
  return null;
}

/**
 * `Option<T>` 스키마를 언랩해 내부 타입 스키마를 반환한다. `Option<T>`가 아니면 null.
 *
 * - `type: ["T", "null"]` (schemars 기본) — null 이 아닌 쪽이 내부 타입
 * - `anyOf: [{...}, {type:"null"}]` — null 이 아닌 쪽이 내부 타입
 */
function unwrapOptionSchema(
  schema: import('./schema.js').JsonSchema,
  _definitions: Record<string, import('./schema.js').JsonSchema>,
): import('./schema.js').JsonSchema | null {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== 'null');
    if (schema.type.length === 2 && nonNull.length === 1) {
      const inner = { ...schema, type: nonNull[0] };
      return inner as import('./schema.js').JsonSchema;
    }
    return null;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const nonNull = schema.anyOf.filter((s) => s.type !== 'null' && !('anyOf' in s));
    if (nonNull.length === 1 && schema.anyOf.some((s) => s.type === 'null')) {
      return nonNull[0];
    }
  }
  return null;
}

/**
 * Collect all fields for a schema in property order (as they appear in the JSON schema).
 *
 * preserve_order 로 schemars/serde_json 이 Rust 구조체 선언 순서를 보존한다 —
 * postcard 는 선언 순서로 인코딩하므로 JSON Schema properties 순서가 곧 와이어
 * 순서다. 과거의 "알파벳 순 가정" 주석은 스키마 생성기가 preserve_order 를
 * 켠 시점부터 더 이상 성립하지 않는다.
 *
 * 미지원 타입 필드는 스킵하지 않고 `unsupported` 로 보고한다 — 호출부(코덱/레지스트리
 * 생성)가 그 명령을 Tier 3(JSON-in-binary) 로 제외시키는 데 쓴다. optional 필드는
 * `Option<T>` 로 와이어에 실리므로(required 여부와 무관하게 태그 바이트가 나감)
 * 필드 집합에 포함한다.
 */
function collectPostcardFields(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): { fields: PostcardField[]; unsupported: string[] } {
  const props = schema.properties;
  if (!props) return { fields: [], unsupported: [] };
  const fields: PostcardField[] = [];
  const unsupported: string[] = [];

  for (const [name, propSchema] of Object.entries(props)) {
    const kind = classifyPostcardField(propSchema, definitions);
    if (!kind) {
      unsupported.push(name);
      continue;
    }
    const field: PostcardField = { name, kind };
    if (kind === 'enum_str' && Array.isArray(propSchema.enum)) {
      field.enumVariants = propSchema.enum.filter((v): v is string => typeof v === 'string');
    }
    if (kind === 'struct' && propSchema.$ref) {
      field.refType = refTypeName(propSchema.$ref);
    }
    // vec_struct/option_struct — 내부 $ref(items 또는 anyOf 내부)를 해석.
    if ((kind === 'vec_struct' || kind === 'option_struct') && !field.refType) {
      const items = propSchema.items;
      const itemsRef = items && !Array.isArray(items) ? items.$ref : undefined;
      const innerRef =
        itemsRef ??
        (Array.isArray(propSchema.anyOf) ? propSchema.anyOf.find((s) => s.$ref)?.$ref : undefined);
      if (innerRef) field.refType = refTypeName(innerRef);
    }
    fields.push(field);
  }
  return { fields, unsupported };
}

/** `#/definitions/Foo` → `Foo`. */
function refTypeName(ref: string): string {
  return ref.startsWith('#/definitions/') ? ref.slice('#/definitions/'.length) : ref;
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
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      for (const sf of subFields) {
        lines.push(generateFieldEncodeExpr(sf, `${valueExpr}.${sf.name}`, definitions, indent));
      }
      return lines.join('\n');
    }
    case 'vec_string':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeString(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{`);
      lines.push(`${indent}  const _arr = ${valueExpr};`);
      lines.push(`${indent}  parts.push(_pcEncodeVarint(_arr.length));`);
      lines.push(`${indent}  for (let _i = 0; _i < _arr.length; _i++) {`);
      for (const sf of subFields) {
        lines.push(
          generateFieldEncodeExpr(sf, `${valueExpr}[_i].${sf.name}`, definitions, `${indent}    `),
        );
      }
      lines.push(`${indent}  }`);
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      return (
        `${indent}{\n` +
        `${indent}  const _opt = ${valueExpr};\n` +
        `${indent}  if (_opt === null || _opt === undefined) {\n` +
        `${indent}    parts.push(new Uint8Array([0]));\n` +
        `${indent}  } else {\n` +
        `${indent}    parts.push(new Uint8Array([1]));\n` +
        generateFieldEncodeExpr(innerField, '_opt', definitions, `${indent}    `)
          .split('\n')
          .map((l) => l)
          .join('\n') +
        `\n${indent}  }\n` +
        `${indent}}`
      );
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsJs = JSON.stringify(variants);
      return (
        `${indent}{\n` +
        `${indent}  const _variants = ${variantsJs};\n` +
        `${indent}  const _idx = _variants.indexOf(${valueExpr});\n` +
        `${indent}  if (_idx < 0) throw new Error('invalid enum value for ${field.name}: ' + ${valueExpr});\n` +
        `${indent}  parts.push(_pcEncodeVarint(_idx));\n` +
        `${indent}}`
      );
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
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
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
    case 'vec_string':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: string[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeString(u8, offset);\n` +
        `${indent}    _arr[_i] = _v.value;\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _arr;\n` +
        `${indent}}`
      );
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{`);
      lines.push(`${indent}  const _len = _pcDecodeVarint(u8, offset);`);
      lines.push(`${indent}  offset += _len.bytesRead;`);
      lines.push(`${indent}  const _arr: ${field.refType}[] = new Array(_len.value);`);
      lines.push(`${indent}  for (let _i = 0; _i < _len.value; _i++) {`);
      lines.push(`${indent}    const _obj: ${field.refType} = {} as ${field.refType};`);
      for (const sf of subFields) {
        lines.push(generateFieldDecodeExpr(sf, `_obj.${sf.name}`, definitions, `${indent}    `));
      }
      lines.push(`${indent}    _arr[_i] = _obj;`);
      lines.push(`${indent}  }`);
      lines.push(`${indent}  ${lvalue} = _arr;`);
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      return (
        `${indent}{\n` +
        `${indent}  const _tag = u8[offset];\n` +
        `${indent}  offset += 1;\n` +
        `${indent}  if (_tag === 0) {\n` +
        `${indent}    ${lvalue} = null;\n` +
        `${indent}  } else {\n` +
        generateFieldDecodeExpr(innerField, lvalue, definitions, `${indent}    `) +
        `\n${indent}  }\n` +
        `${indent}}`
      );
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsJs = JSON.stringify(variants);
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}  const _variants = ${variantsJs};\n` +
        `${indent}  ${lvalue} = _variants[_v.value];\n` +
        `${indent}}`
      );
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/**
 * 패키지 스키마에서 rkyv V2 코덱 파일(`rkyv-codecs.ts`)을 생성합니다.
 *
 * 지원 타입의 명령은 postcard wire format을 사용합니다:
 * - Request:  `[cmd_id: u16 LE @0][postcard(Input) @2...]`
 * - Response: `[ok: u8 @0][pad 7B][postcard(Output) @8...]`
 * - Error:    `[ok: u8 @0 = 0][pad 7B][error_len: u16 @8 LE][error_bytes @10...]`
 *
 * 미지원 타입 필드를 가진 명령은 코덱/레지스트리에서 **제외**되고 엔진의
 * Tier 3(JSON-in-binary) 폴백이 처리한다 — 부분 코덱이 등록되어 폴백을
 * 선점하는 과거 결함(필드 무음 소실)을 구조적으로 봉쇄한다.
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
    const codec = generatePostcardCodec(command, definitions);
    if (codec !== null) output += codec;
  }

  return output;
}

/**
 * Generate a single postcard-based codec for a command.
 * 미지원 필드가 있으면 null 을 반환 — 호출부가 경고와 함께 레지스트리에서 제외한다.
 */
function generatePostcardCodec(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string | null {
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  // unit 출력 `()` → void. postcard 와이어 상 unit 은 0바이트(outFields 자연히 빈 배열).
  const outType = command.outputType === '()' ? 'void' : command.outputType;
  const inResult = collectPostcardFields(command.inputSchema, definitions);
  const outResult = collectPostcardFields(command.outputSchema, definitions);
  // 최상위 필드 + 참조된 중첩 구조체 정의까지 재귀 검증 — 하나라도 깨지면 제외.
  const nestedBad = collectNestedUnsupported(command, definitions);
  if (inResult.unsupported.length > 0 || outResult.unsupported.length > 0 || nestedBad.length > 0) {
    return null;
  }
  const inFields = inResult.fields;
  const outFields = outResult.fields;

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
 * 명령의 입력/출력이 참조하는 중첩 구조체 정의를 재귀 순회하며, postcard 코덱이
 * 깨지는 미지원 필드가 하나라도 있으면 그 정의명 목록을 반환한다.
 */
function collectNestedUnsupported(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string[] {
  const bad: string[] = [];
  const visited = new Set<string>();
  /** 스키마(또는 items)에서 $ref 문자열을 추출. */
  const refOf = (s: import('./schema.js').JsonSchema): string | undefined => {
    if (s.$ref) return s.$ref;
    const items = s.items;
    if (items && !Array.isArray(items) && items.$ref) return items.$ref;
    return undefined;
  };
  const checkRef = (refName: string) => {
    if (visited.has(refName)) return;
    visited.add(refName);
    const def = definitions[refName];
    if (!def) return;
    const { unsupported } = collectPostcardFields(def, definitions);
    if (unsupported.length > 0) bad.push(refName);
    // 하위 $ref 도 재귀 검사
    for (const sub of Object.values(def.properties ?? {})) {
      const ref = refOf(sub);
      if (typeof ref === 'string') checkRef(refTypeName(ref));
    }
  };
  for (const schema of [command.inputSchema, command.outputSchema]) {
    for (const prop of Object.values(schema.properties ?? {})) {
      const ref = refOf(prop);
      if (typeof ref === 'string') checkRef(refTypeName(ref));
    }
  }
  return bad;
}

/**
 * 명령이 postcard 코덱 생성 대상인지(전 필드 완전 코덱) 판정한다.
 * 레지스트리/C++ 코드젠 공용 — 코덱 파일에 주석 stub 를 남기지 않고 여기서
 * 통일 판정한다.
 */
function commandCodecSupported(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): boolean {
  const inResult = collectPostcardFields(command.inputSchema, definitions);
  const outResult = collectPostcardFields(command.outputSchema, definitions);
  if (inResult.unsupported.length > 0 || outResult.unsupported.length > 0) return false;
  return collectNestedUnsupported(command, definitions).length === 0;
}

/**
 * 패키지 스키마에서 rkyv V2 레지스트리 파일(`rkyv-registry.ts`)을 생성합니다.
 *
 * 미지원 타입 명령은 등록에서 제외된다 — 엔진의 Tier 3(JSON-in-binary) 폴백이
 * 처리한다. 제외 시 표준 출력으로 WARN 을 낸다(무음 제외 금지).
 */
export function generateRkyvRegistryTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const included: CommandSchema[] = [];
  const excluded: string[] = [];
  for (const c of schema.commands) {
    if (commandCodecSupported(c, definitions)) {
      included.push(c);
    } else {
      excluded.push(c.name);
      console.warn(
        `[rustra] WARN: command '${c.name}' has fields unsupported by the postcard codec ` +
          `(Option combinations beyond string/number/bool/struct, maps, tuples, non-string enums); ` +
          `excluding from rkyv V2 registry — the engine will route it via Tier 3 JSON fallback.`,
      );
    }
  }

  const entries = included
    .map((c) => {
      const fnName = commandFunctionName(c.name);
      return `  ['${c.name}', ${fnName}Codec]`;
    })
    .join(',\n');

  const codecImports = included.map((c) => commandFunctionName(c.name) + 'Codec').join(', ');

  const header =
    included.length === schema.commands.length
      ? ''
      : `// ${excluded.length} command(s) excluded — unsupported postcard field types (Tier 3 fallback): ${excluded.join(', ')}\n`;

  return (
    header +
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
  return cppEncodeWithGetter(field, get, definitions, indent);
}

/**
 * getter 표현식(jsi::Value 를 반환하는 식)에서 C++ 인코딩 스니펫을 만든다.
 * 옵션의 Some 분기는 이미 jsi::Value(_v) 를 가지고 있으므로 getter 로 그대로
 * 전달한다 — getProperty 를 두 번 부르지 않는다.
 */
function cppEncodeWithGetter(
  field: PostcardField,
  get: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
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
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      return subFields.map((sf) => cppFieldEncodeExpr(sf, subObj, definitions, indent)).join('\n');
    }
    case 'vec_string':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _e = _arr.getValueAtIndex(rt, _i).getString(rt).utf8(rt); w.push_string(_e); } }`
      );
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const arrGet = `${get}.asObject(rt).getArray(rt)`;
      const elem = `_arr.getValueAtIndex(rt, _i).getObject(rt)`;
      const lines: string[] = [];
      lines.push(`${indent}{ auto _arr = ${arrGet}; auto _n = _arr.length(rt); w.push_uvar(_n);`);
      lines.push(`${indent}  for (size_t _i = 0; _i < _n; _i++) { auto _obj = ${elem};`);
      for (const sf of subFields) {
        lines.push(cppFieldEncodeExpr(sf, '_obj', definitions, `${indent}    `));
      }
      lines.push(`${indent}  } }`);
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      return (
        `${indent}{ auto _v = ${get};` +
        ` if (_v.isNull() || _v.isUndefined()) { w.push_u8(0); }` +
        ` else { w.push_u8(1); ${cppEncodeWithGetter(innerField, get, definitions, '')} } }`
      );
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsJs = JSON.stringify(variants);
      return (
        `${indent}{ auto _s = ${get}.getString(rt).utf8(rt);` +
        ` const char* _variants[] = ${variantsJs};` +
        ` int _idx = -1;` +
        ` for (int _i = 0; _i < ${variants.length}; _i++) { if (_s == _variants[_i]) { _idx = _i; break; } }` +
        ` if (_idx < 0) throw jsi::JSError(rt, "invalid enum value for ${field.name}");` +
        ` w.push_uvar((uint32_t)_idx); }`
      );
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
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{ auto _obj = jsi::Object(rt);`);
      for (const sf of subFields) {
        lines.push(cppFieldDecodeExpr(sf, '_obj', definitions, `${indent}  `));
      }
      lines.push(`${indent}  ${objExpr}.setProperty(rt, "${field.name}", _obj); }`);
      return lines.join('\n');
    }
    case 'vec_string':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _s = r.read_string();` +
        ` _arr.setValueAtIndex(rt, _i, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_s.data()), _s.size())); }` +
        ` ${objExpr}.setProperty(rt, "${field.name}", _arr); }`
      );
    case 'vec_struct': {
      if (!field.refType) return `${indent}// unknown vec_struct field: ${field.name}`;
      const structDef = definitions[field.refType];
      if (!structDef) return `${indent}// missing definition for ${field.refType}`;
      const { fields: subFields } = collectPostcardFields(structDef, definitions);
      const lines: string[] = [];
      lines.push(`${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);`);
      lines.push(`${indent}  for (size_t _i = 0; _i < _n; _i++) { auto _obj = jsi::Object(rt);`);
      for (const sf of subFields) {
        lines.push(cppFieldDecodeExpr(sf, '_obj', definitions, `${indent}    `));
      }
      lines.push(`${indent}    _arr.setValueAtIndex(rt, _i, std::move(_obj)); }`);
      lines.push(`${indent}  ${objExpr}.setProperty(rt, "${field.name}", _arr); }`);
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      // Option 디코드: 태그 바이트 → None 이면 null, Some 이면 inner 디코드.
      // inner struct 디코드는 objExpr.setProperty 로 바로 심는다(임시 객체 없이).
      if (innerKind === 'struct') {
        return (
          `${indent}{ auto _tag = r.read_u8();` +
          ` if (_tag == 0) { ${objExpr}.setProperty(rt, "${field.name}", jsi::Value::null()); }` +
          ` else { ${cppFieldDecodeExpr(innerField, objExpr, definitions, '')} } }`
        );
      }
      const inner = cppFieldDecodeExpr(innerField, objExpr, definitions, '');
      // struct 외 inner(setProperty 한 줄) — 태그 분기 안에 넣는다.
      return `${indent}{ auto _tag = r.read_u8(); if (_tag == 0) { ${objExpr}.setProperty(rt, "${field.name}", jsi::Value::null()); } else { ${inner} } }`;
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsJs = JSON.stringify(variants);
      return (
        `${indent}{ auto _idx = r.read_uvar(); const char* _variants[] = ${variantsJs};` +
        ` if (_idx >= ${variants.length}) throw jsi::JSError(rt, "invalid enum index for ${field.name}");` +
        ` ${objExpr}.setProperty(rt, "${field.name}", jsi::String::createFromAscii(rt, _variants[_idx])); }`
      );
    }
    default:
      return `${indent}// unsupported field kind: ${field.kind}`;
  }
}

/** 명령 하나의 C++ encode 함수: [cmd_id u16 LE][postcard(In)] 을 Writer 에 기록. */
function cppEncodeCommand(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const { fields: inFields } = collectPostcardFields(command.inputSchema, definitions);
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

/**
 * 패키지 스키마에서 C++ codec 헤더(`rustra-generated-codecs.hpp`)를 생성한다.
 * RN JSI bridge(RustraJSIBridge.cpp)가 include 하여 encode_by_name/decode_by_name 호출.
 */
export function generateRkyvCodecsHpp(_schema: PackageSchema): string {
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
    `/// cmd_id(u16)로 postcard 요청 바이트를 인코딩한다(정적 명령만).\n` +
    `/// invokeTypedById 진입(P0-3) — 문자열 마샬링/이름 비교체인 없이 u16 디스패치.\n` +
    `/// 인코딩 성공(정적 cmd_id) 시 true, 미발견 시 false.\n` +
    `bool encode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n` +
    `                  const facebook::jsi::Value& args,\n` +
    `                  rustra::codec::Writer& w);\n\n` +
    `/// cmd_id(u16)로 postcard 응답 바디를 디코딩한다(정적 명령만).\n` +
    `/// 미발견 시 JSError throw.\n` +
    `facebook::jsi::Value decode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n` +
    `                                 rustra::codec::Reader& r);\n\n` +
    `/// codegen 시점에 알려진 정적 명령 이름 집합(Tier 3 fallback 분기용).\n` +
    `bool has_static_codec(const std::string& name);\n\n` +
    `} // namespace rustra::generated\n`
  );
}

/**
 * 패키지 스키마에서 C++ codec 구현(`rustra-generated-codecs.cpp`)을 생성한다.
 * postcard 코덱 지원 명령만 디스패치에 포함한다 — 미지원 명령은 has_static_codec
 * 이 false 로 응답해 JS 엔진이 Tier 3(JSON-in-binary) 폴백으로 라우팅하게 한다.
 */
export function generateRkyvCodecsCpp(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const supported = schema.commands.filter((c) => commandCodecSupported(c, definitions));
  const encodeCases = supported
    .map((c) => {
      const fn = commandFunctionName(c.name);
      return `  if (name == "${c.name}") { encode_${fn}(rt, args, w); return true; }`;
    })
    .join('\n');
  const decodeCases = supported
    .map((c) => {
      const fn = commandFunctionName(c.name);
      return `  if (name == "${c.name}") return decode_${fn}(rt, r);`;
    })
    .join('\n');
  const hasCases = supported.map((c) => `  if (name == "${c.name}") return true;`).join('\n');
  // by_id 디스패치 (P0-3) — switch 문으로 u16 cmd_id 를 직접 분기한다.
  // 이름 비교체인(encode_by_name)과 동일한 per-command 함수를 재사용하므로
  // 바이트 출력은 항상 동일하다.
  const encodeIdCases = supported
    .map(
      (c) =>
        `    case ${c.commandId}: encode_${commandFunctionName(c.name)}(rt, args, w); return true;`,
    )
    .join('\n');
  const decodeIdCases = supported
    .map((c) => `    case ${c.commandId}: return decode_${commandFunctionName(c.name)}(rt, r);`)
    .join('\n');

  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.`);
  lines.push(`// C++ postcard codec for the RN JSI fast path (B1).`);
  lines.push(`#include "rustra-generated-codecs.hpp"`);
  lines.push(`#include <jsi/jsi.h>`);
  lines.push(`#include <string>`);
  lines.push(``);
  lines.push(`using namespace facebook::jsi;`);
  // 명시적 `jsi::` 한정자(generated codec bodies) 를 위한 별칭 — RN Pods 의
  // jsi.h 는 `namespace jsi` 를 facebook:: 내부에만 연다.
  lines.push(`namespace jsi = facebook::jsi;`);
  lines.push(`namespace rc = rustra::codec;`);
  lines.push(``);
  for (const command of supported) {
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
  lines.push(`bool encode_by_id(Runtime& rt, uint16_t cmd_id, const Value& args, rc::Writer& w) {`);
  lines.push(`  switch (cmd_id) {`);
  lines.push(encodeIdCases);
  lines.push(`    default: return false; // 동적/알 수 없는 cmd_id — JS 가 Tier 3 fallback 처리`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Value decode_by_id(Runtime& rt, uint16_t cmd_id, rc::Reader& r) {`);
  lines.push(`  switch (cmd_id) {`);
  lines.push(decodeIdCases);
  lines.push(
    `    default: throw JSError(rt, "rustra: no C++ codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
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

// ── positional facade (P2, 성능 후속) ────────────────────────
//
// 정적 명령을 `__rustraNative.xxx(a, b)` positional 시그니처로 감싸 JSI 직접
// 호출(invokeTyped)에 연결한다 — 인자 객체 생성/인코딩을 건너뛴다. 코덱이
// 지원하는 명령만 대상으로 하고, 폴백은 기존 commands.ts 의 global invoke 가
// 담당한다(공존 — facade 는 옵션 산출물).

/**
 * 패키지 스키마에서 positional facade 파일(`positional-facade.ts`)을 생성한다.
 *
 * 각 정적 명령에 대해:
 * - 입력 필드가 0..3개면 positional 파라미터 시그니처
 * - 그 외는 객체 인자 그대로 pass-through
 * 내부적으로 `installRustraPositional(native)` 로 주입받은 native 의
 * `invokeTyped(name, args)` 를 호출한다 (RN JSI). 코덱 미지원 명령은 생성에서
 * 제외된다 — Tier 3 폴백 경로(commands.ts)를 쓰면 된다.
 */
export function generatePositionalFacadeTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const supported = schema.commands.filter((c) => commandCodecSupported(c, definitions));

  let output =
    `// AUTO-GENERATED by @rustra/cli — positional facade (P2).\n` +
    `// 정적 명령을 positional 시그니처로 노출해 JSI invokeTyped 를 직접 호출한다.\n` +
    `// 미지원 명령은 이 파일에 없다 — commands.ts 의 global invoke(Tier 3 폴백 포함) 사용.\n\n`;

  const typeImports = [
    ...new Set(supported.flatMap((c) => [c.inputType, c.outputType].filter((t) => t !== '()'))),
  ].sort();

  if (typeImports.length > 0) {
    output += `import type { ${typeImports.join(', ')} } from './types.js';\n`;
  }
  output += `import type { InvokeOptions } from '@rustra/types';\n\n`;
  output +=
    `/** JSI 네이티브 모듈의 최소 인터페이스 — invokeTypedById 노출 호스트 권장. */\n` +
    `export type PositionalNative = {\n` +
    `  invokeTyped(name: string, args: unknown): unknown;\n` +
    `  /** (P0-3) cmd_id 진입 — 문자열 마샬링을 건너뛴다. 미노출이면 이름 기반으로 폴백. */\n` +
    `  invokeTypedById?(cmdId: number, args: unknown): unknown;\n` +
    `};\n\n` +
    `let _native: PositionalNative | null = null;\n\n` +
    `/** 앱 시작 시 JSI 네이티브를 주입한다 (installRustraJSI 이후). */\n` +
    `export function installRustraPositional(native: PositionalNative): void {\n` +
    `  _native = native;\n` +
    `}\n\n` +
    `function requireNative(): PositionalNative {\n` +
    `  if (!_native) {\n` +
    `    throw new Error('positional facade not installed — call installRustraPositional(native) first');\n` +
    `  }\n` +
    `  return _native;\n` +
    `}\n\n` +
    `/** byId 진입(우선) — 미노출 구 네이티브는 이름 기반 invokeTyped 로 폴백. */\n` +
    `function call<T>(cmdId: number, name: string, args: unknown): T {\n` +
    `  const native = requireNative();\n` +
    `  if (native.invokeTypedById) {\n` +
    `    return native.invokeTypedById(cmdId, args) as T;\n` +
    `  }\n` +
    `  return native.invokeTyped(name, args) as T;\n` +
    `}\n\n`;

  for (const command of supported) {
    const fnName = commandFunctionName(command.name);
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    const { fields } = collectPostcardFields(command.inputSchema, definitions);
    // 0..3개 필드 → positional; 4+ 또는 nested/option 조합은 객체 인자.
    const simple = fields.every(
      (f) => !f.kind.startsWith('option_') && f.kind !== 'struct' && f.kind !== 'vec_struct',
    );
    const cmdId = command.commandId ?? 0;
    if (fields.length <= 3 && simple) {
      const params = fields
        .map((f) => `${f.name}: ${tsFieldType(f, command.inputType)}`)
        .join(', ');
      const argObject =
        fields.length === 0 ? 'undefined' : `{ ${fields.map((f) => `${f.name}`).join(', ')} }`;
      output +=
        `export function ${fnName}(${params ? params + ', ' : ''}options?: InvokeOptions): Promise<${outType}> {\n` +
        `  void options;\n` +
        `  return Promise.resolve(call<${outType}>(${cmdId}, '${command.name}', ${argObject}));\n` +
        `}\n\n`;
    } else {
      const inType = command.inputType;
      output +=
        `export function ${fnName}(input: ${inType}, options?: InvokeOptions): Promise<${outType}> {\n` +
        `  void options;\n` +
        `  return Promise.resolve(call<${outType}>(${cmdId}, '${command.name}', input));\n` +
        `}\n\n`;
    }
  }
  return output;
}

/** 필드의 TS 타입 표현 — input 타입 이름 기반 단순 매핑. */
function tsFieldType(field: PostcardField, _ownerType: string): string {
  switch (field.kind) {
    case 'zigzag':
      return 'number';
    case 'f64':
    case 'f32':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'string':
      return 'string';
    case 'enum_str':
      return 'string';
    case 'vec_zigzag':
    case 'vec_f64':
      return 'number[]';
    case 'vec_bool':
      return 'boolean[]';
    case 'vec_string':
      return 'string[]';
    case 'set_zigzag':
      return 'Set<number>';
    case 'set_f64':
      return 'Set<number>';
    case 'set_bool':
      return 'Set<boolean>';
    default:
      return 'unknown';
  }
}
