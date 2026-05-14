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
  tsTypeFromSchema,
} from './codegen.js';

/**
 * 패키지 스키마에서 TypeScript 타입 정의 파일(`types.ts`)을 생성합니다.
 */
export function generateTypesTs(schema: PackageSchema): string {
  let output =
    "export type { EngineClient, RustraError } from '@rustra/types';\n" +
    "export { RustraCommandError } from '@rustra/types';\n\n";

  const allDefinitions: Record<string, import("./schema.js").JsonSchema> = {};
  for (const command of schema.commands) {
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
    if (!emitted.has(command.outputType)) {
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

  const imports = Array.from(typeNames).sort().join(', ');
  let output = `import type { ${imports} } from './types.js';\n`;
  output += `import { invoke } from '@rustra/types';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    output +=
      `export function ${fnName}(input: ${command.inputType}): Promise<${command.outputType}> {\n` +
      `  return invoke<${command.outputType}>('${command.name}', input);\n` +
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

// ── rkyv V2 codec generation ────────────────────────────────

type WireFieldKind =
  | 'i64' | 'i32' | 'u32' | 'u16' | 'f64' | 'f32' | 'bool'
  | 'string' | 'vec_i64' | 'vec_f64' | 'vec_i32' | 'vec_u8' | 'vec_bool';

type WireField = {
  name: string;
  offset: number;
  size: number;
  kind: WireFieldKind;
};

type VarWireField = {
  name: string;
  kind: WireFieldKind;
};

type WireLayout = {
  fixedFields: WireField[];
  varFields: VarWireField[];
  fixedRegionSize: number;
  tier: 1 | 2 | 3;
};

const FIELD_SIZES: Record<string, number> = {
  i64: 8,
  i32: 4,
  u32: 4,
  u16: 2,
  f64: 8,
  f32: 4,
  bool: 1,
};

function alignTo(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment;
}

function isFixedKind(kind: WireFieldKind): boolean {
  return kind in FIELD_SIZES;
}

function schemaFieldToWireType(
  schema: import('./schema.js').JsonSchema,
): WireFieldKind | null {
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'integer') {
    if (schema.format === 'int64') return 'i64';
    return 'i32';
  }
  if (schema.type === 'number') {
    if (schema.format === 'double') return 'f64';
    return 'f32';
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = schema.items;
    if (items.type === 'integer') {
      if (items.format === 'int64' || !items.format) return 'vec_i64';
      if (items.format === 'int32') return 'vec_i32';
      return null;
    }
    if (items.type === 'number') {
      if (items.format === 'double' || !items.format) return 'vec_f64';
      return null;
    }
    if (items.type === 'boolean') return 'vec_bool';
    return null;
  }
  return null;
}

/** Classify a schema's fields into fixed and variable, computing tier. */
function classifySchemaFields(
  schema: import('./schema.js').JsonSchema,
  headerSize: number,
): {
  fixedFields: WireField[];
  varFields: VarWireField[];
  fixedRegionSize: number;
  tier: 1 | 2 | 3;
} {
  const props = schema.properties;
  if (!props) return { fixedFields: [], varFields: [], fixedRegionSize: headerSize, tier: 1 };

  const required = new Set(schema.required ?? []);
  const fixedFields: WireField[] = [];
  const varFields: VarWireField[] = [];
  let tier: 1 | 2 | 3 = 1;
  let offset = headerSize;

  for (const [name, propSchema] of Object.entries(props)) {
    if (!required.has(name)) {
      tier = 3;
      continue;
    }
    const kind = schemaFieldToWireType(propSchema);
    if (!kind) {
      tier = 3;
      continue;
    }
    if (isFixedKind(kind)) {
      const size = FIELD_SIZES[kind];
      offset = alignTo(offset, size);
      fixedFields.push({ name, offset, size, kind });
      offset += size;
    } else {
      if (tier === 1) tier = 2;
      varFields.push({ name, kind });
    }
  }

  return { fixedFields, varFields, fixedRegionSize: offset, tier };
}

function computeWireLayout(command: CommandSchema): WireLayout {
  return classifySchemaFields(command.inputSchema, 8);
}

/** Check if a command's output schema is supported (not Tier 3). */
function isOutputSupported(command: CommandSchema): boolean {
  const props = command.outputSchema.properties;
  if (!props) return true;
  const required = new Set(command.outputSchema.required ?? []);
  for (const [name, propSchema] of Object.entries(props)) {
    if (!required.has(name)) return false;
    const kind = schemaFieldToWireType(propSchema);
    if (!kind) return false;
  }
  return true;
}

/** Compute the output layout (response side). */
function computeOutputLayout(command: CommandSchema): {
  fixedFields: WireField[];
  varFields: VarWireField[];
  fixedRegionSize: number;
} {
  const result = classifySchemaFields(command.outputSchema, 8);
  // We only care about fixedFields, varFields, fixedRegionSize here
  return {
    fixedFields: result.fixedFields,
    varFields: result.varFields,
    fixedRegionSize: result.fixedRegionSize,
  };
}

function writeFixedFieldExpr(field: WireField, varExpr: string): string {
  const o = field.offset;
  const le = 'true';
  switch (field.kind) {
    case 'i64':
      return (
        `    view.setInt32(${o}, ${varExpr}, ${le});\n` +
        `    view.setInt32(${o + 4}, ${varExpr} >= 0 ? 0 : -1, ${le});`
      );
    case 'i32':
      return `    view.setInt32(${o}, ${varExpr}, ${le});`;
    case 'u32':
      return `    view.setUint32(${o}, ${varExpr}, ${le});`;
    case 'u16':
      return `    view.setUint16(${o}, ${varExpr}, ${le});`;
    case 'f64':
      return `    view.setFloat64(${o}, ${varExpr}, ${le});`;
    case 'f32':
      return `    view.setFloat32(${o}, ${varExpr}, ${le});`;
    case 'bool':
      return `    view.setUint8(${o}, ${varExpr} ? 1 : 0);`;
    default:
      return '';
  }
}

function readFixedFieldExpr(field: WireField, lvalue: string): string {
  const o = field.offset;
  switch (field.kind) {
    case 'i64':
      return `    ${lvalue} = view.getInt32(${o}, true);`;
    case 'i32':
      return `    ${lvalue} = view.getInt32(${o}, true);`;
    case 'u32':
      return `    ${lvalue} = view.getUint32(${o}, true);`;
    case 'u16':
      return `    ${lvalue} = view.getUint16(${o}, true);`;
    case 'f64':
      return `    ${lvalue} = view.getFloat64(${o}, true);`;
    case 'f32':
      return `    ${lvalue} = view.getFloat32(${o}, true);`;
    case 'bool':
      return `    ${lvalue} = u8[${o}] === 1;`;
    default:
      return '';
  }
}

/** Size expression for a variable-length input field. */
function varFieldSizeExpr(field: VarWireField): string {
  const name = field.name;
  switch (field.kind) {
    case 'string':
      return `4 + ${name}Bytes.length`;
    case 'vec_i64':
      return `4 + ${name}Len * 8`;
    case 'vec_f64':
      return `4 + ${name}Len * 8`;
    case 'vec_i32':
      return `4 + ${name}Len * 4`;
    case 'vec_bool':
      return `4 + ${name}Len`;
    case 'vec_u8':
      return `4 + args.${name}.length`;
    default:
      return '0';
  }
}

/** Write expression for a variable-length input field. */
function writeVarFieldExpr(field: VarWireField): string {
  const name = field.name;
  switch (field.kind) {
    case 'string':
      return (
        `    view.setUint32(cursor, ${name}Bytes.length, true);\n` +
        `    new Uint8Array(buf, cursor + 4).set(${name}Bytes);\n` +
        `    cursor += 4 + ${name}Bytes.length;`
      );
    case 'vec_i64':
      return (
        `    view.setUint32(cursor, ${name}Len * 8, true);\n` +
        `    cursor += 4;\n` +
        `    for (let i = 0; i < ${name}Len; i++) {\n` +
        `      const v = args.${name}[i];\n` +
        `      view.setInt32(cursor, v, true);\n` +
        `      view.setInt32(cursor + 4, v >= 0 ? 0 : -1, true);\n` +
        `      cursor += 8;\n` +
        `    }`
      );
    case 'vec_f64':
      return (
        `    view.setUint32(cursor, ${name}Len * 8, true);\n` +
        `    cursor += 4;\n` +
        `    for (let i = 0; i < ${name}Len; i++) {\n` +
        `      view.setFloat64(cursor, args.${name}[i], true);\n` +
        `      cursor += 8;\n` +
        `    }`
      );
    case 'vec_i32':
      return (
        `    view.setUint32(cursor, ${name}Len * 4, true);\n` +
        `    cursor += 4;\n` +
        `    for (let i = 0; i < ${name}Len; i++) {\n` +
        `      view.setInt32(cursor, args.${name}[i], true);\n` +
        `      cursor += 4;\n` +
        `    }`
      );
    case 'vec_bool':
      return (
        `    view.setUint32(cursor, ${name}Len, true);\n` +
        `    cursor += 4;\n` +
        `    for (let i = 0; i < ${name}Len; i++) {\n` +
        `      view.setUint8(cursor, args.${name}[i] ? 1 : 0);\n` +
        `      cursor += 1;\n` +
        `    }`
      );
    case 'vec_u8':
      return (
        `    view.setUint32(cursor, args.${name}.length, true);\n` +
        `    cursor += 4;\n` +
        `    for (let i = 0; i < args.${name}.length; i++) {\n` +
        `      view.setUint8(cursor, args.${name}[i]);\n` +
        `      cursor += 1;\n` +
        `    }`
      );
    default:
      return '';
  }
}

/** Generate decode statements for a variable-length output field. */
function readVarFieldDecodeExpr(field: VarWireField, lvalue: string): string {
  switch (field.kind) {
    case 'string':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      ${lvalue} = new TextDecoder().decode(u8.slice(cursor, cursor + len));\n` +
        `      cursor += len;\n` +
        `    }`
      );
    case 'vec_i64':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      const count = len >>> 3;\n` +
        `      const arr: number[] = new Array(count);\n` +
        `      for (let i = 0; i < count; i++) {\n` +
        `        arr[i] = view.getInt32(cursor, true);\n` +
        `        cursor += 8;\n` +
        `      }\n` +
        `      ${lvalue} = arr;\n` +
        `    }`
      );
    case 'vec_f64':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      const count = len >>> 3;\n` +
        `      const arr: number[] = new Array(count);\n` +
        `      for (let i = 0; i < count; i++) {\n` +
        `        arr[i] = view.getFloat64(cursor, true);\n` +
        `        cursor += 8;\n` +
        `      }\n` +
        `      ${lvalue} = arr;\n` +
        `    }`
      );
    case 'vec_i32':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      const count = len >>> 2;\n` +
        `      const arr: number[] = new Array(count);\n` +
        `      for (let i = 0; i < count; i++) {\n` +
        `        arr[i] = view.getInt32(cursor, true);\n` +
        `        cursor += 4;\n` +
        `      }\n` +
        `      ${lvalue} = arr;\n` +
        `    }`
      );
    case 'vec_bool':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      const arr: boolean[] = new Array(len);\n` +
        `      for (let i = 0; i < len; i++) {\n` +
        `        arr[i] = u8[cursor] === 1;\n` +
        `        cursor += 1;\n` +
        `      }\n` +
        `      ${lvalue} = arr;\n` +
        `    }`
      );
    case 'vec_u8':
      return (
        `    {\n` +
        `      const len = view.getUint32(cursor, true);\n` +
        `      cursor += 4;\n` +
        `      const arr: number[] = new Array(len);\n` +
        `      for (let i = 0; i < len; i++) {\n` +
        `        arr[i] = u8[cursor];\n` +
        `        cursor += 1;\n` +
        `      }\n` +
        `      ${lvalue} = arr;\n` +
        `    }`
      );
    default:
      return '';
  }
}

/**
 * 패키지 스키마에서 rkyv V2 코덱 파일(`rkyv-codecs.ts`)을 생성합니다.
 *
 * Tier 1: 고정폭 프리미티브 필드만
 * Tier 2: String 또는 Vec<primitive> 필드 포함
 * Tier 3: 중첩 구조체, enum, Option<T> 등 — JSON fallback
 */
export function generateRkyvCodecsTs(schema: PackageSchema): string {
  const allTypes = schema.commands
    .flatMap((c) => [c.inputType, c.outputType])
    .filter((v, i, a) => a.indexOf(v) === i);

  let output =
    "import type { RkyvV2Codec } from '@rustra/types';\n" +
    `import type { ${allTypes.join(', ')} } from './types.js';\n\n`;

  for (const command of schema.commands) {
    const layout = computeWireLayout(command);
    const outputTier3 = !isOutputSupported(command);

    if (layout.tier === 3 || outputTier3) {
      // Tier 3: JSON fallback codec
      output += generateTier3Codec(command);
      continue;
    }

    const fnName = commandFunctionName(command.name);
    const inType = command.inputType;
    const outType = command.outputType;

    output += `export const ${fnName}Codec: RkyvV2Codec<${inType}, ${outType}> = {\n`;
    output += `  commandId: ${command.commandId},\n`;

    // ── encode ──
    output += generateEncodeMethod(command, layout);

    // ── decode ──
    output += generateDecodeMethod(command);

    output += `};\n\n`;
  }

  return output;
}

/** Generate a Tier 3 (JSON fallback) codec for a command. */
function generateTier3Codec(command: CommandSchema): string {
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  const outType = command.outputType;

  const lines: string[] = [];
  lines.push(`export const ${fnName}Codec: RkyvV2Codec<${inType}, ${outType}> = {`);
  lines.push(`  commandId: ${command.commandId},`);
  lines.push('');
  lines.push(`  encode(args: ${inType}): ArrayBuffer {`);
  lines.push(`    const json = JSON.stringify(args);`);
  lines.push(`    const jsonBytes = new TextEncoder().encode(json);`);
  lines.push(`    const buf = new ArrayBuffer(2 + jsonBytes.length);`);
  lines.push(`    const view = new DataView(buf);`);
  lines.push(`    view.setUint16(0, ${command.commandId}, true);`);
  lines.push(`    new Uint8Array(buf, 2).set(jsonBytes);`);
  lines.push(`    return buf;`);
  lines.push(`  },`);
  lines.push('');
  lines.push(`  decode(buf: ArrayBuffer): { ok: boolean; result?: ${outType}; error?: string } {`);
  lines.push(`    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };`);
  lines.push(`    const u8 = new Uint8Array(buf);`);
  lines.push(`    const view = new DataView(buf);`);
  lines.push(`    const ok = u8[0] === 1;`);
  lines.push(`    if (!ok) {`);
  lines.push(`      const errLen = view.getUint16(8, true);`);
  lines.push(`      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';`);
  lines.push(`      return { ok: false, error: err };`);
  lines.push(`    }`);
  lines.push(`    // Tier 3 success: [ok=1 @0][pad 3B][json_len: u32 @4 LE][json_bytes @8...]`);
  lines.push(`    const jsonLen = view.getUint32(4, true);`);
  lines.push(`    const jsonStr = new TextDecoder().decode(u8.slice(8, 8 + jsonLen));`);
  lines.push(`    const result: ${outType} = JSON.parse(jsonStr);`);
  lines.push(`    return { ok: true, result };`);
  lines.push(`  },`);
  lines.push(`};`);
  lines.push('');

  return lines.join('\n') + '\n';
}

function generateEncodeMethod(command: CommandSchema, layout: WireLayout): string {
  const lines: string[] = [];

  if (layout.tier === 1 && layout.varFields.length === 0) {
    // Pure Tier 1: all fixed, known size
    lines.push(`  encode(args: ${command.inputType}): ArrayBuffer {`);
    lines.push(`    const buf = new ArrayBuffer(${layout.fixedRegionSize});`);
    lines.push(`    const view = new DataView(buf);`);
    lines.push(`    view.setUint16(0, ${command.commandId}, true);`);
    for (const f of layout.fixedFields) {
      lines.push(writeFixedFieldExpr(f, `args.${f.name}`));
    }
    lines.push(`    return buf;`);
    lines.push(`  },`);
    return lines.join('\n') + '\n';
  }

  // Tier 2: need to compute variable-length portions
  lines.push(`  encode(args: ${command.inputType}): ArrayBuffer {`);

  // Pre-compute byte array for string fields
  for (const vf of layout.varFields) {
    if (vf.kind === 'string') {
      lines.push(`    const ${vf.name}Bytes = new TextEncoder().encode(args.${vf.name});`);
    }
  }
  // Pre-compute length for vec fields (except vec_u8 which uses .length inline)
  for (const vf of layout.varFields) {
    if (vf.kind !== 'string' && vf.kind !== 'vec_u8') {
      lines.push(`    const ${vf.name}Len = args.${vf.name}.length;`);
    }
  }

  // Compute total buffer size: fixed region + sum of var field sizes
  const fixedSize = layout.fixedRegionSize;
  const sizeParts = [`${fixedSize}`];
  for (const vf of layout.varFields) {
    sizeParts.push(varFieldSizeExpr(vf));
  }
  lines.push(`    const buf = new ArrayBuffer(${sizeParts.join(' + ')});`);
  lines.push(`    const view = new DataView(buf);`);
  lines.push(`    view.setUint16(0, ${command.commandId}, true);`);

  // Write fixed fields at their computed offsets
  for (const f of layout.fixedFields) {
    lines.push(writeFixedFieldExpr(f, `args.${f.name}`));
  }

  // Write variable fields
  lines.push(`    let cursor = ${fixedSize};`);
  for (const vf of layout.varFields) {
    lines.push(writeVarFieldExpr(vf));
  }

  lines.push(`    return buf;`);
  lines.push(`  },`);
  return lines.join('\n') + '\n';
}

function generateDecodeMethod(command: CommandSchema): string {
  const outType = command.outputType;
  const lines: string[] = [];

  lines.push(`  decode(buf: ArrayBuffer): { ok: boolean; result?: ${outType}; error?: string } {`);
  lines.push(`    if (buf.byteLength < 8) return { ok: false, error: 'response too short' };`);
  lines.push(`    const u8 = new Uint8Array(buf);`);
  lines.push(`    const view = new DataView(buf);`);
  lines.push(`    const ok = u8[0] === 1;`);
  lines.push(`    if (!ok) {`);
  lines.push(`      const errLen = view.getUint16(8, true);`);
  lines.push(`      const err = errLen > 0 ? new TextDecoder().decode(u8.slice(10, 10 + errLen)) : 'invoke failed';`);
  lines.push(`      return { ok: false, error: err };`);
  lines.push(`    }`);

  // Analyze output fields
  const outLayout = computeOutputLayout(command);

  if (outLayout.fixedFields.length === 0 && outLayout.varFields.length === 0) {
    lines.push(`    return { ok: true, result: {} as ${outType} };`);
  } else {
    lines.push(`    const result: ${outType} = {} as any;`);

    // Read fixed output fields
    for (const f of outLayout.fixedFields) {
      lines.push(readFixedFieldExpr(f, `result.${f.name}`));
    }

    // Read variable output fields
    if (outLayout.varFields.length > 0) {
      lines.push(`    let cursor = ${outLayout.fixedRegionSize};`);
      for (const vf of outLayout.varFields) {
        lines.push(readVarFieldDecodeExpr(vf, `result.${vf.name}`));
      }
    }

    lines.push(`    return { ok: true, result };`);
  }

  lines.push(`  },`);
  return lines.join('\n') + '\n';
}

/**
 * 패키지 스키마에서 rkyv V2 레지스트리 파일(`rkyv-registry.ts`)을 생성합니다.
 * Tier 1/2/3 모든 명령을 포함합니다.
 */
export function generateRkyvRegistryTs(schema: PackageSchema): string {
  // Include all commands (Tier 1, 2, and 3)
  const included = schema.commands;

  const entries = included
    .map((c) => {
      const fnName = commandFunctionName(c.name);
      return `  ['${c.name}', ${fnName}Codec]`;
    })
    .join(',\n');

  const codecImports = included
    .map((c) => commandFunctionName(c.name) + 'Codec')
    .join(', ');

  return (
    `import { ${codecImports} } from './rkyv-codecs.js';\n\n` +
    `export const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([\n` +
    entries +
    `,\n]);\n`
  );
}
