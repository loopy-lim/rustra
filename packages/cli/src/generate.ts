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
  output += `import { invoke } from '@rustra/react-native';\n\n`;

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

type WireField = {
  name: string;
  offset: number;
  size: number;
  tsType: 'i64' | 'i32' | 'u32' | 'u16' | 'f64' | 'f32' | 'bool';
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

function schemaFieldToWireType(
  schema: import('./schema.js').JsonSchema,
): WireField['tsType'] | null {
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'integer') {
    if (schema.format === 'int64') return 'i64';
    return 'i32';
  }
  if (schema.type === 'number') {
    if (schema.format === 'double') return 'f64';
    return 'f32';
  }
  return null;
}

function computeWireLayout(
  command: CommandSchema,
): { fields: WireField[]; totalSize: number; isFixed: boolean } {
  const props = command.inputSchema.properties;
  if (!props) return { fields: [], totalSize: 8, isFixed: false };

  const required = new Set(command.inputSchema.required ?? []);
  const fields: WireField[] = [];
  let isFixed = true;
  let offset = 8; // command_id: u16 + 6B padding = 8 bytes

  for (const [name, propSchema] of Object.entries(props)) {
    if (!required.has(name)) {
      isFixed = false;
      continue;
    }
    const wireType = schemaFieldToWireType(propSchema);
    if (!wireType) {
      isFixed = false;
      continue;
    }
    const size = FIELD_SIZES[wireType];
    offset = alignTo(offset, size);
    fields.push({ name, offset, size, tsType: wireType });
    offset += size;
  }

  return { fields, totalSize: offset, isFixed };
}

function writeDataViewExpr(field: WireField, varName: string): string {
  const le = 'true';
  switch (field.tsType) {
    case 'i64':
      return (
        `  view.setInt32(${field.offset}, ${varName}, ${le});\n` +
        `  view.setInt32(${field.offset + 4}, ${varName} >= 0 ? 0 : -1, ${le});`
      );
    case 'i32':
      return `  view.setInt32(${field.offset}, ${varName}, ${le});`;
    case 'u32':
      return `  view.setUint32(${field.offset}, ${varName}, ${le});`;
    case 'u16':
      return `  view.setUint16(${field.offset}, ${varName}, ${le});`;
    case 'f64':
      return `  view.setFloat64(${field.offset}, ${varName}, ${le});`;
    case 'f32':
      return `  view.setFloat32(${field.offset}, ${varName}, ${le});`;
    case 'bool':
      return `  view.setUint8(${field.offset}, ${varName} ? 1 : 0);`;
  }
}

function readDataViewExpr(field: WireField, outputVar: string): string {
  switch (field.tsType) {
    case 'i64':
      return `  ${outputVar} = view.getInt32(${field.offset}, true);`;
    case 'i32':
      return `  ${outputVar} = view.getInt32(${field.offset}, true);`;
    case 'u32':
      return `  ${outputVar} = view.getUint32(${field.offset}, true);`;
    case 'u16':
      return `  ${outputVar} = view.getUint16(${field.offset}, true);`;
    case 'f64':
      return `  ${outputVar} = view.getFloat64(${field.offset}, true);`;
    case 'f32':
      return `  ${outputVar} = view.getFloat32(${field.offset}, true);`;
    case 'bool':
      return `  ${outputVar} = u8[${field.offset}] === 1;`;
  }
}

/**
 * 패키지 스키마에서 rkyv V2 코덱 파일(`rkyv-codecs.ts`)을 생성합니다.
 *
 * Tier 1 (고정폭 프리미티브 필드만) 코덱만 생성합니다.
 * 복합 타입은 이후 Phase 5에서 지원합니다.
 */
export function generateRkyvCodecsTs(schema: PackageSchema): string {
  let output =
    "import type { RkyvV2Codec } from '@rustra/react-native';\n" +
    "import type { " +
    schema.commands
      .flatMap((c) => [c.inputType, c.outputType])
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ') +
    " } from './types.js';\n\n";

  for (const command of schema.commands) {
    const layout = computeWireLayout(command);
    if (!layout.isFixed) {
      output += `// ${command.name}: skipped (non-primitive fields, not Tier 1)\n\n`;
      continue;
    }

    const fnName = commandFunctionName(command.name);
    const encodeLines = layout.fields
      .map((f) => writeDataViewExpr(f, `args.${f.name}`))
      .join('\n');

    const respOffset = 8;

    output += `export const ${fnName}Codec: RkyvV2Codec<${command.inputType}, ${command.outputType}> = {\n`;
    output += `  commandId: ${command.commandId},\n`;
    output += `  encode(args: ${command.inputType}): ArrayBuffer {\n`;
    output += `    const buf = new ArrayBuffer(${layout.totalSize});\n`;
    output += `    const view = new DataView(buf);\n`;
    output += `    view.setUint16(0, ${command.commandId}, true);\n`;
    if (encodeLines) output += encodeLines + '\n';
    output += `    return buf;\n`;
    output += `  },\n`;
    output += `  decode(buf: ArrayBuffer): { ok: boolean; result?: ${command.outputType}; error?: string } {\n`;
    output += `    if (buf.byteLength < 16) return { ok: false, error: 'response too short' };\n`;
    output += `    const u8 = new Uint8Array(buf);\n`;
    output += `    const view = new DataView(buf);\n`;
    output += `    const ok = u8[0] === 1;\n`;
    output += `    if (!ok) return { ok: false, error: 'invoke failed' };\n`;

    const outProps = command.outputSchema.properties ?? {};
    const outRequired = new Set(command.outputSchema.required ?? []);
    const resultFields = Object.entries(outProps).filter(([n]) =>
      outRequired.has(n),
    );

    if (resultFields.length > 0) {
      output += `    const result: ${command.outputType} = {} as any;\n`;
      let respFieldOffset = respOffset;
      for (const [name, propSchema] of resultFields) {
        const wireType = schemaFieldToWireType(propSchema);
        if (wireType) {
          const field: WireField = {
            name,
            offset: respFieldOffset,
            size: FIELD_SIZES[wireType],
            tsType: wireType,
          };
          output += readDataViewExpr(field, `result.${name}`) + '\n';
          respFieldOffset = alignTo(
            respFieldOffset + field.size,
            8,
          );
        }
      }
      output += `    return { ok: true, result };\n`;
    } else {
      output += `    return { ok: true, result: {} as ${command.outputType} };\n`;
    }
    output += `  },\n`;
    output += `};\n\n`;
  }

  return output;
}

/**
 * 패키지 스키마에서 rkyv V2 레지스트리 파일(`rkyv-registry.ts`)을 생성합니다.
 */
export function generateRkyvRegistryTs(schema: PackageSchema): string {
  const entries = schema.commands
    .filter((c) => {
      const layout = computeWireLayout(c);
      return layout.isFixed;
    })
    .map((c) => {
      const fnName = commandFunctionName(c.name);
      return `  ['${c.name}', ${fnName}Codec]`;
    })
    .join(',\n');

  return (
    `import { ${schema.commands.map((c) => commandFunctionName(c.name) + 'Codec').join(', ')} } from './rkyv-codecs.js';\n\n` +
    `export const rkyvV2Registry = new Map<string, import('@rustra/react-native').RkyvV2Codec<any, any>>([\n` +
    entries +
    `,\n]);\n`
  );
}
