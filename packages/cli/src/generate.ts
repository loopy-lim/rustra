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
import { buildCodecIr } from './codec-ir.js';
import type { CodecIrNode } from './codec-ir.js';

function generatedJsDoc(description: string): string {
  const body = escapeJsDoc(description)
    .split('\n')
    .map((line) => (line.length > 0 ? ` * ${line}` : ' *'))
    .join('\n');
  return `/**\n${body}\n */\n`;
}

function finishGeneratedText(output: string): string {
  return `${output.trimEnd()}\n`;
}

/**
 * (이벤트 계약) 스키마의 `events` 섹션에서 `events.ts` 를 생성한다 —
 * 이벤트 페이로드 타입 + 이름 리터럴 유니언 + 구독 헬퍼.
 *
 * 커맨드와 동일한 "한 번 정의하면 어디서든 타입 안전" 계약을 이벤트에
 * 적용한다: Rust `PackageBuilder::event::<E>("name")` 선언이 여기 페이로드
 * 타입으로 내려온다. 구독 헬퍼는 플랫폼별 구독 함수를 주입받는 형태다
 * (RN `subscribeEvent` / Tauri `@rustra/tauri` 의 `subscribeEvent`).
 *
 * 스키마에 events 섹션이 없으면 빈 문자열을 반환한다(파일 미생성).
 */
export function generateEventsTs(schema: PackageSchema): string {
  const events = schema.events ?? [];
  if (events.length === 0) return '';

  // 이벤트 페이로드 정의 수집 ($ref 대상) — 전체를 하나의 definitions 맵으로.
  const allDefinitions: Record<string, import('./schema.js').JsonSchema> = {};
  for (const ev of events) {
    if (ev.definitions) {
      for (const [key, value] of Object.entries(ev.definitions)) {
        allDefinitions[key] = value;
      }
    }
    collectDefinitions(ev.payload, allDefinitions);
  }

  let output = '';

  // 페이로드 타입 정의 — 커맨드 타입과 동일한 전략.
  const emitted = new Set<string>();
  for (const [name, defSchema] of Object.entries(allDefinitions)) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  // 이벤트 이름 유니언 + 페이로드 매핑.
  const names = events.map((e) => `'${e.name}'`).join(' | ');
  output += `/** 선언된 rustra 이벤트 이름 (Rust \`PackageBuilder::event\`). */\n`;
  output += `export type RustraEventName = ${names};\n\n`;
  output += `/** 이벤트 이름 → 페이로드 타입 매핑. */\n`;
  output += `export type RustraEventPayloads = {\n`;
  for (const ev of events) {
    const payloadType = tsTypeFromSchema(ev.payload, allDefinitions);
    output += `  '${ev.name}': ${payloadType};\n`;
  }
  output += `};\n\n`;

  // 구독 헬퍼 — 플랫폼 구독 함수(콜백 해지를 반환)를 주입받아 이름/페이로드를
  // 타입으로 연결한다. RN 의 subscribeEvent 는 (name, cb) → unsubscribe 다.
  output += `/** 플랫폼 구독 함수 — RN \`subscribeEvent\` / Tauri 래퍼 등. */\n`;
  output += `export type SubscribeFn = <N extends RustraEventName>(\n`;
  output += `  name: N,\n`;
  output += `  callback: (payload: RustraEventPayloads[N]) => void,\n`;
  output += `) => (() => void) | Promise<() => void>;\n\n`;
  output += `/** 타입 안전 이벤트 구독 — 페이로드가 자동으로 좁혀진다. */\n`;
  output += `export function onRustraEvent<N extends RustraEventName>(\n`;
  output += `  subscribe: SubscribeFn,\n`;
  output += `  name: N,\n`;
  output += `  callback: (payload: RustraEventPayloads[N]) => void,\n`;
  output += `): (() => void) | Promise<() => void> {\n`;
  output += `  return subscribe(name, callback as (payload: RustraEventPayloads[N]) => void);\n`;
  output += `}\n`;

  return output;
}

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
      output += generatedJsDoc(defSchema.description);
    }
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  for (const command of schema.commands) {
    if (command.inputType !== '()' && !emitted.has(command.inputType)) {
      emitted.add(command.inputType);
      if (typeof command.inputSchema.description === 'string') {
        output += generatedJsDoc(command.inputSchema.description);
      }
      output += `export type ${command.inputType} = ${tsTypeFromSchema(command.inputSchema, allDefinitions)};\n\n`;
    }
    // unit 출력 타입 `()` 은 TS 타입명으로 쓸 수 없다 — Promise<void> 로 표현.
    if (command.outputType !== '()' && !emitted.has(command.outputType)) {
      emitted.add(command.outputType);
      if (typeof command.outputSchema.description === 'string') {
        output += generatedJsDoc(command.outputSchema.description);
      }
      output += `export type ${command.outputType} = ${tsTypeFromSchema(command.outputSchema, allDefinitions)};\n\n`;
    }
  }

  return finishGeneratedText(output);
}

/**
 * 패키지 스키마에서 TypeScript 명령 헬퍼 함수 파일(`commands.ts`)을 생성합니다.
 *
 * Tauri-like 글로벌 invoke 패턴: `configure()`로 엔진을 한 번 설정하면
 * 이후 `addNumbers({ a: 42 })`로 engine 파라미터 없이 호출 가능합니다.
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
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
  const generatedHelpers = new Set<string>(['invokeGenerated']);
  for (const command of schema.commands) {
    if (bufferCommandField(command, definitions)) {
      generatedHelpers.add('invokeGeneratedBytes');
      continue;
    }
    const fields = generatedFieldRoute(command, definitions);
    if (fields) {
      generatedHelpers.add(
        fields.length === 2 ? 'createGeneratedFields2' : `invokeGeneratedFields${fields.length}`,
      );
    }
  }
  output += `import { ${[...generatedHelpers].sort().join(', ')} } from '@rustra/types';\n`;
  output += `import type { InvokeOptions } from '@rustra/types';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    // unit 출력 `()` → Promise<void>.
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    if (typeof command.inputSchema?.description === 'string') {
      output += generatedJsDoc(command.inputSchema.description);
    }
    if (command.inputType === '()') {
      output +=
        `export function ${fnName}(options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', undefined, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    } else {
      const bufferField = bufferCommandField(command, definitions);
      if (bufferField) {
        output +=
          `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedBytes<${outType}>(${command.commandId}, '${command.name}', input, input[${JSON.stringify(bufferField.name)}], options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      const fields = generatedFieldRoute(command, definitions);
      if (fields) {
        if (fields.length === 2) {
          const fieldKeys = fields.map((field) => JSON.stringify(field.name)).join(', ');
          output +=
            `export const ${fnName} = createGeneratedFields2<${command.inputType}, ${outType}>` +
            `(${command.commandId}, '${command.name}', ${fieldKeys}, '${fnName}');\n\n`;
          continue;
        }
        const fieldArgs = fields.map((field) => `input[${JSON.stringify(field.name)}]`).join(', ');
        output +=
          `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedFields${fields.length}<${outType}>(${command.commandId}, '${command.name}', input, ${fieldArgs}, options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      output +=
        `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', input, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    }
  }

  return finishGeneratedText(output);
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
// ── 새 정수 폭(i128 등) 추가 체크리스트 ──────────────────────
// 다음 전부를 손봐야 한다: (1) 이 union, (2) classifyPostcardField 스칼라 arm,
// (3) generateFieldEncodeExpr / generateFieldDecodeExpr / generateFieldEncodeIntoExpr
// (+ ENC_INTO_KINDS), (4) 복합 대응 kind(vec_/set_/map_/option_* — 있으면),
// (5) tsFieldType 타입 표면, (6) Rust 미러 게이트(rkyv_codec.rs
// js_field_supported[_with_defs]), (7) Rust ts_type_from_schema(codegen.rs),
// (8) C++ 게이트(cppComplexNativeSupported / cppSafe), (9) 64-bit 헬퍼
// 코드젠(codegen.ts postcardHelperSource) + 와이어 픽스처 양면.
type PostcardFieldKind =
  | 'zigzag'
  | 'uvar' // unsigned 정수(u8/u16/u32/u64 아님 — u64 는 전용 uvar64) — plain varint(zigzag 아님)
  | 'zigzag64' // int64 — 64-bit zigzag(_pcEncodeZigzag64/_pcDecodeZigzag64)
  | 'uvar64' // uint64 — 64-bit varint(_pcEncodeVarint64/_pcDecodeVarint64)
  | 'f64'
  | 'f32'
  | 'bool'
  | 'string'
  | 'bytes' // Vec<u8> — postcard 는 len varint + raw 바이트(원소별 varint 아님)
  | 'vec_zigzag'
  | 'vec_f64'
  | 'vec_bool'
  | 'vec_i64' // Vec<int64> — 원소별 zigzag64(_pc*64 헬퍼)
  | 'vec_u64' // Vec<uint64> — 원소별 uvar64
  | 'set_zigzag'
  | 'set_f64'
  | 'set_bool'
  | 'set_i64' // Set<int64> — 원소별 zigzag64
  | 'set_u64' // Set<uint64> — 원소별 uvar64
  | 'set_uvar' // Set<unsigned> — 원소별 plain varint
  | 'struct' // nested struct via $ref; set_* = Set (wire-compatible with vec)
  | 'vec_string'
  | 'vec_struct'
  | 'vec_uvar' // Vec<unsigned> — 원소별 plain varint
  | 'map_zigzag' // HashMap<String, signed> — count + (key,value)*
  | 'map_uvar'
  | 'map_i64' // HashMap<String, int64> — 값 원소별 zigzag64
  | 'map_u64' // HashMap<String, uint64> — 값 원소별 uvar64
  | 'map_f64'
  | 'map_bool'
  | 'map_string'
  | 'tuple' // (A, B, …) — 무길이접두, 요소를 선언순으로 그대로 나열
  | 'data_enum' // payload 있는 enum(oneOf) — variant varint + 필드 평탄화
  | 'option_zigzag'
  | 'option_uvar'
  | 'option_zigzag64' // Option<int64> — 태그 + zigzag64
  | 'option_uvar64' // Option<uint64> — 태그 + uvar64
  | 'option_f64'
  | 'option_f32'
  | 'option_bool'
  | 'option_string'
  | 'option_struct'
  | 'option_bytes'
  | 'enum_str'; // string-only enum (postcard: variant index varint)

type PostcardField = {
  name: string;
  kind: PostcardFieldKind;
  /** For struct fields: the resolved type name from $ref */
  refType?: string;
  /** For enum_str fields: variant values in declaration order (postcard index) */
  enumVariants?: string[];
  /** For tuple fields: 요소별 분류 결과(선언순) */
  tupleItems?: PostcardField[];
  /** For data_enum fields: variant별 태그와 필드 목록(선언순) */
  enumVariantsData?: { tag: string; fields: PostcardField[] }[];
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
  depth = 0,
): PostcardFieldKind | null {
  if (depth > 8) return null; // 과도한 중첩(순환 $ref 포함) — Rust 게이트와 동일 한계
  // schemars는 tuple newtype(`struct Handle(u32)`)를 single-entry allOf +
  // $ref로 표현한다. serde/postcard 표면은 내부 값 하나뿐이므로 해당 스키마를
  // 투명하게 벗겨야 ChannelHandle/ResourceHandle도 fast path를 사용할 수 있다.
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return classifyPostcardField(schema.allOf[0], definitions, depth + 1);
  }
  // string-only enum — postcard는 variant index varint로 직렬화한다.
  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allStrings = schema.enum.every((v) => typeof v === 'string');
    if (allStrings) return 'enum_str';
  }
  // $ref — Rust 게이트(resolve_ref)와 동일하게 정의를 따라가 판정한다.
  // 정의를 무시하고 무조건 struct 로 보면 $ref → string enum(oneOf 아닌
  // {type:"string",enum:[...]}) 정의에서 와이어가 붕괴한다(0바이트 인코딩).
  if (schema.$ref) {
    const resolved = definitions[refTypeName(schema.$ref)];
    if (!resolved) return 'struct'; // 정의 미발견 — 기존 동작 유지
    // 정의가 object+properties(구조체)면 struct — 재귀 분류기에는 이 형태가
    // 없다(프로퍼티 스키마가 아니라 정의 자체이므로).
    if (resolved.type === 'object' && resolved.properties && !resolved.additionalProperties) {
      return 'struct';
    }
    return classifyPostcardField(resolved, definitions, depth + 1);
  }
  if (schema.type === 'boolean') return 'bool';
  // integer — postcard 는 unsigned(u8/u16/u32/u64)를 plain varint, signed 를
  // zigzag 로 직렬화한다. format 구분이 없으면 signed 로 간주(하위호환).
  // probe: u32=70000 → [240,162,4] (plain); i64=-300 → [215,4] (zigzag).
  // u64/i64 는 JS 경계에서 전체 64비트가 필요하므로 전용 64-bit 종류로 분리해
  // _pc*64 헬퍼(bigint 무손실)를 emit 한다 — 와이어는 동일 LEB128/zigzag.
  if (schema.type === 'integer') {
    if (schema.format === 'uint64') return 'uvar64';
    if (schema.format === 'int64') return 'zigzag64';
    const unsigned =
      schema.format === 'uint8' || schema.format === 'uint16' || schema.format === 'uint32';
    return unsigned ? 'uvar' : 'zigzag';
  }
  if (schema.type === 'number') {
    if (schema.format === 'float') return 'f32';
    return 'f64';
  }
  if (schema.type === 'string') return 'string';
  // `Option<T>` — schemars는 `type: ["T","null"]` 또는 `anyOf: [T, null]`로 내보낸다.
  // probe: Option<u32> 스키마는 `type:["integer","null"], format:"uint32"` —
  // format 이 상위로 유지되므로 unwrap 후 일반 classify 로 재판정한다.
  const optionInner = unwrapOptionSchema(schema, definitions);
  if (optionInner) {
    const inner = classifyPostcardField(optionInner, definitions);
    if (inner === null) return null;
    if (inner === 'zigzag') return 'option_zigzag';
    if (inner === 'uvar') return 'option_uvar';
    if (inner === 'zigzag64') return 'option_zigzag64';
    if (inner === 'uvar64') return 'option_uvar64';
    if (inner === 'f64') return 'option_f64';
    if (inner === 'f32') return 'option_f32';
    if (inner === 'bool') return 'option_bool';
    if (inner === 'string') return 'option_string';
    if (inner === 'struct') return 'option_struct';
    if (inner === 'bytes') return 'option_bytes';
    // enum_str/vec/set/map/tuple 등 조합은 postcard 미지원 — complex route가 검사한다.
    return null;
  }
  if (schema.type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = schema.items;
    // Vec<u8>: postcard len varint + raw bytes (NOT per-element varint).
    // probe: vec![1,2,3] -> [3, 1, 2, 3].
    if (items.type === 'integer' && items.format === 'uint8') return 'bytes';
    const itemsUnsigned =
      items.format === 'uint8' || items.format === 'uint16' || items.format === 'uint32';
    // uniqueItems(Set): wire = array. encode [...value], decode new Set(...).
    if (items.type === 'integer') {
      if (items.format === 'uint64') return schema.uniqueItems ? 'set_u64' : 'vec_u64';
      if (items.format === 'int64') return schema.uniqueItems ? 'set_i64' : 'vec_i64';
      if (itemsUnsigned) return schema.uniqueItems ? 'set_uvar' : 'vec_uvar';
      return schema.uniqueItems ? 'set_zigzag' : 'vec_zigzag';
    }
    if (items.type === 'number') return schema.uniqueItems ? 'set_f64' : 'vec_f64';
    if (items.type === 'boolean') return schema.uniqueItems ? 'set_bool' : 'vec_bool';
    if (items.type === 'string') return 'vec_string';
    if (items.$ref) {
      // items $ref 도 정의를 따라간다 — Rust 게이트와 정합. $ref → string enum
      // 정의라면 vec_string 이어야 한다(무조건 vec_struct 는 와이어 붕괴).
      const resolved = definitions[refTypeName(items.$ref)];
      if (!resolved) return 'vec_struct';
      if (resolved.type === 'object' && resolved.properties && !resolved.additionalProperties) {
        return 'vec_struct';
      }
      const inner = classifyPostcardField(resolved, definitions, depth + 1);
      return inner === 'struct' ? 'vec_struct' : inner === 'string' ? 'vec_string' : null;
    }
    return null;
  }
  // tuple (A, B, ...): items is an array + minItems === maxItems.
  // wire: elements in order, no length prefix (probe: ("hi",-5) -> [2,104,105,9]).
  // 모든 요소가 지원 타입일 때만 postcard fast-path — 요소 하나라도 미지원이면
  // complex route가 검사한다.
  if (schema.type === 'array' && Array.isArray(schema.items)) {
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems === maxItems && minItems !== undefined && minItems > 0) {
      const allOk = schema.items.every(
        (it) => classifyPostcardField(it, definitions, depth + 1) !== null,
      );
      return allOk ? 'tuple' : null;
    }
    return null;
  }
  // payload 있는 enum — schemars 는 $ref → oneOf 로 내보낸다. postcard는
  // Rust declaration order를 증명할 수 없어 제외하고 complex route가 schema
  // variant key를 사용한다.
  if (schema.oneOf) return null;
  // dynamic map HashMap<String, T>: additionalProperties, no fixed properties.
  // wire: entry-count varint + (key string, value)*
  // (probe: {a:1,b:2} -> [2, 1,98,4, 1,97,2]; decode is order-independent).
  if (
    schema.type === 'object' &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object' &&
    !schema.properties
  ) {
    const v = schema.additionalProperties;
    if (v.type === 'integer') {
      if (v.format === 'uint64') return 'map_u64';
      if (v.format === 'int64') return 'map_i64';
      const unsigned = v.format === 'uint8' || v.format === 'uint16' || v.format === 'uint32';
      return unsigned ? 'map_uvar' : 'map_zigzag';
    }
    if (v.type === 'number') return 'map_f64';
    if (v.type === 'boolean') return 'map_bool';
    if (v.type === 'string') return 'map_string';
    return null; // struct/array-valued map - complex route가 검사한다.
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
 * 생성)가 그 명령을 postcard에서 제외시키는 데 쓴다. optional 필드는
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
    // tuple — 요소별 분류 결과를 선언순으로 저장(인코딩/디코딩에 사용).
    if (kind === 'tuple' && Array.isArray(propSchema.items)) {
      field.tupleItems = propSchema.items
        .map((it) => {
          const itemKind = classifyPostcardField(it, definitions);
          return itemKind === null ? null : ({ name: '_', kind: itemKind } as PostcardField);
        })
        .filter((f): f is PostcardField => f !== null);
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

/** Postcard's inline struct emitter cannot represent a cyclic definition. */
function hasCyclicRef(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  path = new Set<string>(),
  visited = new Set<JsonSchemaIdentity>(),
): boolean {
  const identity = schema as JsonSchemaIdentity;
  if (visited.has(identity)) return false;
  visited.add(identity);
  if (schema.$ref) {
    const name = refTypeName(schema.$ref);
    if (path.has(name)) return true;
    const definition = definitions[name];
    if (!definition) return false;
    const nextPath = new Set(path);
    nextPath.add(name);
    return hasCyclicRef(definition, definitions, nextPath, visited);
  }
  const children: import('./schema.js').JsonSchema[] = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    children.push(schema.additionalProperties);
  }
  return children.some((child) => hasCyclicRef(child, definitions, path, visited));
}

// Object identity is sufficient here: the helper only prevents revisiting an
// already traversed inline schema object while `$ref` path state detects the
// actual named-definition cycle.
type JsonSchemaIdentity = import('./schema.js').JsonSchema;

/**
 * 스키마 트리에 int64/uint64 필드가 있는지 검사한다. TS postcard fast-path 게이트
 * 해제(A2) 후 이 검사는 C++ 코드젠 전용이다 — C++ 정적 코덱은 트랙 B(Hermes
 * bigint 스파이크)까지 와이드 정수를 emit 하지 않으므로 그 명령을 광고
 * 대상에서 제외해 JS 폴백으로 보낸다.
 */
function hasWideIntegerField(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  path = new Set<string>(),
): boolean {
  if (schema.type === 'integer' && (schema.format === 'int64' || schema.format === 'uint64')) {
    return true;
  }
  if (schema.$ref) {
    const name = refTypeName(schema.$ref);
    if (path.has(name)) return false;
    const definition = definitions[name];
    if (!definition) return false;
    const nextPath = new Set(path);
    nextPath.add(name);
    return hasWideIntegerField(definition, definitions, nextPath);
  }
  const children: import('./schema.js').JsonSchema[] = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    children.push(schema.additionalProperties);
  }
  return children.some((child) => hasWideIntegerField(child, definitions, path));
}

/** Set-shaped arrays stay on the schema-driven JS complex route. */
function hasSet(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  path = new Set<string>(),
): boolean {
  if (schema.uniqueItems === true) return true;
  if (schema.$ref) {
    const name = refTypeName(schema.$ref);
    if (path.has(name)) return false;
    const definition = definitions[name];
    if (!definition) return false;
    const nextPath = new Set(path);
    nextPath.add(name);
    return hasSet(definition, definitions, nextPath);
  }
  const children: import('./schema.js').JsonSchema[] = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    children.push(schema.additionalProperties);
  }
  return children.some((child) => hasSet(child, definitions, path));
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
/** encodeInto 가 다루는 필드 kind — 단일 패스 직접 기록이 자연스러운 것들.
 * PostcardField 유니언에 실제 존재하는 kind 만 포함한다(없는 kind 를 넣으면
 * 코드젠이 영원히 그 경로를 켜지 않는 것처럼 보인다).
 * 의도적 제외: 복합 64-bit kind(vec_i64/vec_u64, set_i64/set_u64,
 * map_i64/map_u64)와 tuple 은 커서 재작성 루프가 복잡해 encodeInto 를 켜지
 * 않는다 — 이런 필드를 가진 코덱은 parts 조립 encode 만 얻는다. */
const ENC_INTO_KINDS = new Set([
  'zigzag',
  'uvar',
  'zigzag64',
  'uvar64',
  'f64',
  'f32',
  'bool',
  'string',
  'bytes',
  'vec_zigzag',
  'vec_uvar',
]);

/**
 * encodeInto 용 필드 기록식 — parts 배열 없이 out/w 커서에 직접 쓴다.
 * generateFieldEncodeExpr 와 완전히 동일한 와이어 바이트를 낸다.
 */
function generateFieldEncodeIntoExpr(
  field: PostcardField,
  valueExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  void definitions;
  const writeVarint = (target: string) =>
    `${indent}{ let _v = ${target}; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }`;
  const writeZigzag = (target: string) =>
    `${indent}{ const _z = ${target} >= 0 ? ${target} * 2 : -${target} * 2 - 1; let _v = _z; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; }`;
  switch (field.kind) {
    case 'zigzag':
      return writeZigzag(valueExpr);
    case 'uvar':
      return writeVarint(valueExpr);
    case 'f64':
      return (
        `${indent}{ ensure(8); _dvScratch.setFloat64(0, ${valueExpr}, true); ` +
        `for (let _i = 0; _i < 8; _i++) out[w++] = _dvScratchU8[_i]; }`
      );
    case 'f32':
      return (
        `${indent}{ ensure(4); _dvScratch.setFloat32(0, ${valueExpr}, true); ` +
        `for (let _i = 0; _i < 4; _i++) out[w++] = _dvScratchU8[_i]; }`
      );
    case 'bool':
      return `${indent}{ ensure(1); out[w++] = ${valueExpr} ? 1 : 0; }`;
    case 'string':
      return (
        `${indent}{ const _s = ${valueExpr}; const _u = _utf8Encode(_s); ` +
        `ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }`
      );
    case 'bytes':
      return (
        `${indent}{ const _b = ${valueExpr}; const _u = typeof _b === 'string' ? _utf8Encode(_b) : _b instanceof Uint8Array ? _b : new Uint8Array(_b); ` +
        `ensure(5 + _u.length); let _v = _u.length; do { out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; out.set(_u, w); w += _u.length; }`
      );
    case 'vec_zigzag':
      return (
        `${indent}{ const _arr = ${valueExpr}; ` +
        `let _v = _arr.length; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; ` +
        `for (let _i = 0; _i < _arr.length; _i++) { const _z = _arr[_i] >= 0 ? _arr[_i] * 2 : -_arr[_i] * 2 - 1; let _x = _z; do { ensure(1); out[w++] = (_x % 128) | 0x80; _x = Math.floor(_x / 128); } while (_x > 0); out[w - 1] &= 0x7f; } }`
      );
    case 'vec_uvar':
      return (
        `${indent}{ const _arr = ${valueExpr}; ` +
        `let _v = _arr.length; do { ensure(1); out[w++] = (_v % 128) | 0x80; _v = Math.floor(_v / 128); } while (_v > 0); out[w - 1] &= 0x7f; ` +
        `for (let _i = 0; _i < _arr.length; _i++) { let _x = _arr[_i]; do { ensure(1); out[w++] = (_x % 128) | 0x80; _x = Math.floor(_x / 128); } while (_x > 0); out[w - 1] &= 0x7f; } }`
      );
    case 'uvar64':
      // u64 커서 직접 기록 — safe number 는 number 산술(_pcEncodeVarint64 와
      // 동일 출력), 그 밖은 bigint 산술로 64비트 전체를 무손실 기록한다.
      return (
        `${indent}{ const _v = ${valueExpr}; ` +
        `if (typeof _v === 'number' && Number.isSafeInteger(_v) && _v >= 0) { ` +
        `let _x = _v; do { ensure(1); out[w++] = (_x % 128) | 0x80; _x = Math.floor(_x / 128); } while (_x > 0); out[w - 1] &= 0x7f; ` +
        `} else { const _b = BigInt(_v); if (_b < 0n) throw new Error('varint must be non-negative: ' + _b.toString()); ` +
        `let _x = _b; do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; } }`
      );
    case 'zigzag64':
      // i64 커서 직접 기록 — bigint zigzag((n<<1)^(n>>63)) 후 varint64. 입력이
      // i64 범위 밖이면 _pcEncodeZigzag64 계약과 동일하게 throw 한다.
      return (
        `${indent}{ let _x = BigInt(${valueExpr}); ` +
        `if (_x < _pcI64Min || _x > _pcI64Max) throw new Error('zigzag64 input outside i64 range: ' + _x.toString()); ` +
        `_x = (_x << 1n) ^ (_x >> 63n); ` +
        `do { ensure(1); out[w++] = Number(_x & 0x7fn) | 0x80; _x >>= 7n; } while (_x !== 0n); out[w - 1] &= 0x7f; }`
      );
    default:
      // 나머지 vec_* 는 원소 종류별 루프가 필요해 여기서 다루지 않는다 —
      // ENC_INTO_KINDS 체크가 encodeInto 자체를 스킵하게 한다.
      return `${indent}/* unsupported kind: ${field.kind} */`;
  }
}

function generateFieldEncodeExpr(
  field: PostcardField,
  valueExpr: string,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  indent: string,
): string {
  switch (field.kind) {
    case 'zigzag':
      return `${indent}parts.push(_pcEncodeZigzagVarint(${valueExpr}));`;
    case 'uvar':
      return `${indent}parts.push(_pcEncodeVarint(${valueExpr}));`;
    case 'zigzag64':
      // i64 — _pcEncodeZigzag64 가 바이트 배열을 반환한다(zigzag → varint64).
      return `${indent}parts.push(_pcEncodeZigzag64(${valueExpr}));`;
    case 'uvar64':
      // u64 — 2^53 초과는 bigint 로 무손실(타입 표면이 number | bigint).
      return `${indent}parts.push(_pcEncodeVarint64(${valueExpr}));`;
    case 'f64':
      return `${indent}parts.push(_pcEncodeF64(${valueExpr}));`;
    case 'f32':
      return `${indent}parts.push(_pcEncodeF32(${valueExpr}));`;
    case 'bool':
      return `${indent}parts.push(new Uint8Array([${valueExpr} ? 1 : 0]));`;
    case 'string':
      return `${indent}parts.push(_pcEncodeString(${valueExpr}));`;
    case 'bytes': {
      // Vec<u8> — len varint + raw bytes (probe: [1,2,3] -> [3,1,2,3]).
      return (
        `${indent}{\n` +
        `${indent}  const _b = ${valueExpr};\n` +
        `${indent}  const _u = _b instanceof Uint8Array ? _b : new Uint8Array(_b);\n` +
        `${indent}  parts.push(_pcEncodeVarint(_u.length));\n` +
        `${indent}  parts.push(_u);\n` +
        `${indent}}`
      );
    }
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
    case 'vec_i64':
      // Vec<i64> — 원소별 zigzag64(2^53 초과는 bigint 허용).
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeZigzag64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_u64':
      // Vec<u64> — 원소별 uvar64.
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeVarint64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'vec_uvar':
      // Vec<unsigned> — 원소별 plain varint (probe: vec![70000u32] -> [1, f0 a2 04]).
      return (
        `${indent}{\n` +
        `${indent}  const _arr = ${valueExpr};\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeVarint(_arr[_i]));\n` +
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
    case 'set_i64':
      // Set<i64> — 원소별 zigzag64.
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeZigzag64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'set_u64':
      // Set<u64> — 원소별 uvar64.
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeVarint64(_arr[_i]));\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    case 'set_uvar':
      return (
        `${indent}{\n` +
        `${indent}  const _arr = [...${valueExpr}];\n` +
        `${indent}  parts.push(_pcEncodeVarint(_arr.length));\n` +
        `${indent}  for (let _i = 0; _i < _arr.length; _i++) {\n` +
        `${indent}    parts.push(_pcEncodeVarint(_arr[_i]));\n` +
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
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_i64':
    case 'map_u64':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      // HashMap<String, T> — count varint + (key string, value)*.
      // probe: {a:1,b:2} -> [2, 1,98,4, 1,97,2]. 디코딩은 순서독립이나
      // 인코딩은 결정론을 위해 키를 정렬한다(Rust BTreeMap 정렬과 일치).
      const valueEncoder =
        field.kind === 'map_zigzag'
          ? '_pcEncodeZigzagVarint(_v)'
          : field.kind === 'map_uvar'
            ? '_pcEncodeVarint(_v)'
            : field.kind === 'map_i64'
              ? '_pcEncodeZigzag64(_v)'
              : field.kind === 'map_u64'
                ? '_pcEncodeVarint64(_v)'
                : field.kind === 'map_f64'
                  ? '_pcEncodeF64(_v)'
                  : field.kind === 'map_bool'
                    ? 'new Uint8Array([_v ? 1 : 0])'
                    : '_pcEncodeString(_v)';
      return (
        `${indent}{\n` +
        `${indent}  const _map = ${valueExpr};\n` +
        `${indent}  const _keys = Object.keys(_map).sort();\n` +
        `${indent}  parts.push(_pcEncodeVarint(_keys.length));\n` +
        `${indent}  for (const _k of _keys) {\n` +
        `${indent}    const _v = _map[_k];\n` +
        `${indent}    parts.push(_pcEncodeString(_k));\n` +
        `${indent}    parts.push(${valueEncoder});\n` +
        `${indent}  }\n` +
        `${indent}}`
      );
    }
    case 'tuple': {
      // (A, B, …) — 무길이접두, 요소를 선언순으로 그대로 나열
      // (probe: ("hi",-5) -> [2,104,105,9]).
      const items = field.tupleItems ?? [];
      const lines: string[] = [];
      lines.push(`${indent}{`);
      items.forEach((it, i) => {
        lines.push(generateFieldEncodeExpr(it, `${valueExpr}[${i}]`, definitions, `${indent}  `));
      });
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_uvar':
    case 'option_zigzag64':
    case 'option_uvar64':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct':
    case 'option_bytes': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_uvar: 'uvar',
          option_zigzag64: 'zigzag64',
          option_uvar64: 'uvar64',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
          option_bytes: 'bytes',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      return (
        `${indent}{
` +
        `${indent}  const _opt = ${valueExpr};
` +
        `${indent}  if (_opt === null || _opt === undefined) {
` +
        `${indent}    parts.push(new Uint8Array([0]));
` +
        `${indent}  } else {
` +
        `${indent}    parts.push(new Uint8Array([1]));
` +
        generateFieldEncodeExpr(innerField, '_opt', definitions, `${indent}    `) +
        `
${indent}  }
` +
        `${indent}}`
      );
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsJs = JSON.stringify(variants);
      return (
        `${indent}{
` +
        `${indent}  const _variants = ${variantsJs};
` +
        `${indent}  const _idx = _variants.indexOf(${valueExpr});
` +
        `${indent}  if (_idx < 0) throw new Error('invalid enum value for ${field.name}: ' + ${valueExpr});
` +
        `${indent}  parts.push(_pcEncodeVarint(_idx));
` +
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
    case 'uvar':
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'uvar64':
      // u64 — safe 범위는 number, 2^53 초과는 bigint 복원(_pcDecodeVarint64 계약).
      // 객체 조립은 값을 그대로 통과하므로 number|bigint 공용합이 문제없다.
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeVarint64(u8, offset);\n` +
        `${indent}  ${lvalue} = _v.value;\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'zigzag64':
      // i64 — varint64 디코드 후 zigzag 복원(반환은 number|bigint).
      return (
        `${indent}{\n` +
        `${indent}  const _v = _pcDecodeVarint64(u8, offset);\n` +
        `${indent}  ${lvalue} = _pcDecodeZigzag64(_v.value);\n` +
        `${indent}  offset += _v.bytesRead;\n` +
        `${indent}}`
      );
    case 'bytes': {
      // Vec<u8> — len varint + raw bytes.
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  ${lvalue} = u8.slice(offset, offset + _len.value);\n` +
        `${indent}  offset += _len.value;\n` +
        `${indent}}`
      );
    }
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
    case 'vec_i64':
      // Vec<i64> — 원소별 varint64 + zigzag 복원(safe 범위 밖은 bigint).
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: (number | bigint)[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint64(u8, offset);\n` +
        `${indent}    _arr[_i] = _pcDecodeZigzag64(_v.value);\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _arr;\n` +
        `${indent}}`
      );
    case 'vec_u64':
      // Vec<u64> — 원소별 varint64(safe 범위 밖은 bigint).
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: (number | bigint)[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint64(u8, offset);\n` +
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
    case 'vec_uvar':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _arr: number[] = new Array(_len.value);\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint(u8, offset);\n` +
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
    case 'set_i64':
      // Set<i64> — 원소별 varint64 + zigzag 복원.
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<number | bigint>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint64(u8, offset);\n` +
        `${indent}    _set.add(_pcDecodeZigzag64(_v.value));\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _set;\n` +
        `${indent}}`
      );
    case 'set_u64':
      // Set<u64> — 원소별 varint64.
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<number | bigint>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint64(u8, offset);\n` +
        `${indent}    _set.add(_v.value);\n` +
        `${indent}    offset += _v.bytesRead;\n` +
        `${indent}  }\n` +
        `${indent}  ${lvalue} = _set;\n` +
        `${indent}}`
      );
    case 'set_uvar':
      return (
        `${indent}{\n` +
        `${indent}  const _len = _pcDecodeVarint(u8, offset);\n` +
        `${indent}  offset += _len.bytesRead;\n` +
        `${indent}  const _set = new Set<number>();\n` +
        `${indent}  for (let _i = 0; _i < _len.value; _i++) {\n` +
        `${indent}    const _v = _pcDecodeVarint(u8, offset);\n` +
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
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_i64':
    case 'map_u64':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const valueDecoder =
        field.kind === 'map_zigzag'
          ? '_pcDecodeZigzagVarint(u8, offset)'
          : field.kind === 'map_uvar'
            ? '_pcDecodeVarint(u8, offset)'
            : field.kind === 'map_i64'
              ? '_pcDecodeVarint64(u8, offset)'
              : field.kind === 'map_u64'
                ? '_pcDecodeVarint64(u8, offset)'
                : field.kind === 'map_f64'
                  ? '_pcDecodeF64(u8, offset)'
                  : null;
      const lines: string[] = [];
      lines.push(`${indent}{`);
      lines.push(`${indent}  const _len = _pcDecodeVarint(u8, offset);`);
      lines.push(`${indent}  offset += _len.bytesRead;`);
      lines.push(`${indent}  const _map: Record<string, unknown> = {};`);
      lines.push(`${indent}  for (let _i = 0; _i < _len.value; _i++) {`);
      lines.push(`${indent}    const _k = _pcDecodeString(u8, offset);`);
      lines.push(`${indent}    offset += _k.bytesRead;`);
      if (valueDecoder) {
        lines.push(`${indent}    const _v = ${valueDecoder};`);
        if (field.kind === 'map_i64') {
          lines.push(`${indent}    _map[_k.value] = _pcDecodeZigzag64(_v.value);`);
        } else {
          lines.push(`${indent}    _map[_k.value] = _v.value;`);
        }
        lines.push(`${indent}    offset += _v.bytesRead;`);
      } else if (field.kind === 'map_bool') {
        lines.push(`${indent}    _map[_k.value] = u8[offset] === 1;`);
        lines.push(`${indent}    offset += 1;`);
      } else {
        lines.push(`${indent}    const _v = _pcDecodeString(u8, offset);`);
        lines.push(`${indent}    _map[_k.value] = _v.value;`);
        lines.push(`${indent}    offset += _v.bytesRead;`);
      }
      lines.push(`${indent}  }`);
      lines.push(`${indent}  ${lvalue} = _map;`);
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'tuple': {
      // (A, B, …) — 무접두 나열. 요소별 디코드를 offset 누적으로 생성.
      const items = field.tupleItems ?? [];
      const lines: string[] = [];
      lines.push(`${indent}{`);
      items.forEach((it, i) => {
        lines.push(generateFieldDecodeExpr(it, `${lvalue}[${i}]`, definitions, `${indent}  `));
      });
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
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
    case 'option_uvar':
    case 'option_zigzag64':
    case 'option_uvar64':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct':
    case 'option_bytes': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_uvar: 'uvar',
          option_zigzag64: 'zigzag64',
          option_uvar64: 'uvar64',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
          option_bytes: 'bytes',
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
 * postcard 미지원 명령은 recursive complex codec을 우선 생성하고, 두 코덱이
 * 모두 지원하지 못하는 경우에만 코덱/레지스트리에서 제외되어 엔진의 Tier
 * 3(JSON-in-binary) 폴백으로 간다. 부분 코덱이 등록되어 필드를 무음 소실하는
 * 경로는 허용하지 않는다.
 */
export function generateRkyvCodecsTs(schema: PackageSchema): string {
  const allTypes = new Set<string>();
  for (const command of schema.commands) {
    // unit 타입 `()` (예: Result<()> 반환 command) 은 import 대상이 아니다.
    if (command.inputType !== '()') allTypes.add(command.inputType);
    if (command.outputType !== '()') allTypes.add(command.outputType);
  }

  const definitions = collectAllDefinitions(schema);

  // Include definition types (e.g. Item) referenced by struct fields in codecs
  const definitionTypes = Object.keys(definitions);
  const importTypes = [...new Set([...allTypes, ...definitionTypes])].sort();

  let output = postcardHelperSource();

  output += "import { createComplexCodec } from '@rustra/types';\n";
  output += "import type { RkyvV2Codec, RustraError, ComplexSchema } from '@rustra/types';\n";
  output += `import type { ${importTypes.join(', ')} } from './types.js';\n\n`;

  for (const command of schema.commands) {
    const codec = generatePostcardCodec(command, definitions);
    if (codec !== null) {
      output += codec;
    } else if (complexCodecSupported(command, definitions)) {
      output += generateComplexCodec(command, definitions);
    }
  }

  return finishGeneratedText(output);
}

/**
 * Generate a single postcard-based codec for a command.
 * 미지원 필드가 있으면 null 을 반환 — 호출부가 경고와 함께 레지스트리에서 제외한다.
 */
function generatePostcardCodec(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string | null {
  if (!commandCodecSupported(command, definitions)) return null;
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

  // ── encodeInto (재사용 버퍼 직접 기록 — 대형 페이로드 할당 회피) ──
  // encode 의 parts 조립과 동일한 필드 순서로 계산된 크기만큼 재사용 버퍼에
  // 직접 쓴다. 반환 subarray(0..len)를 호출자가 다음 호출의 reuse 로 재전달한다.
  if (inFields.every((f) => ENC_INTO_KINDS.has(f.kind))) {
    lines.push('');
    lines.push(`  encodeInto(args: ${inType}, reuse?: Uint8Array): Uint8Array {`);
    lines.push(`    let out = reuse ?? new Uint8Array(64);`);
    lines.push(`    let w = 0;`);
    lines.push(`    const ensure = (need: number) => {`);
    lines.push(`      if (w + need <= out.length) return;`);
    lines.push(`      const grown = new Uint8Array(Math.max(out.length * 2, w + need));`);
    lines.push(`      grown.set(out.subarray(0, w));`);
    lines.push(`      out = grown;`);
    lines.push(`    };`);
    lines.push(`    ensure(2);`);
    lines.push(
      `    out[w++] = ${command.commandId & 0xff}; out[w++] = ${(command.commandId >> 8) & 0xff};`,
    );
    for (const field of inFields) {
      lines.push(generateFieldEncodeIntoExpr(field, `args.${field.name}`, definitions, '    '));
    }
    lines.push(`    return out.subarray(0, w);`);
    lines.push(`  },`);
  }

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
    if (Array.isArray(s.allOf) && s.allOf.length === 1 && s.allOf[0]?.$ref) {
      return s.allOf[0].$ref;
    }
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
  if (command.inputType !== '()' && command.inputSchema.type !== 'object') return false;
  if (command.outputType !== '()' && command.outputSchema.type !== 'object') return false;
  if (
    hasCyclicRef(command.inputSchema, definitions) ||
    hasCyclicRef(command.outputSchema, definitions)
  ) {
    return false;
  }
  // int64/uint64 는(uvar64/zigzag64 kind, _pc*64 헬퍼로) postcard fast-path 가
  // 64비트 전 범위를 무손실 처리한다 — 과거의 complex 폴백 게이트(hasWideInteger)
  // 는 해제됐다. Set(uniqueItems) 만 여전히 complex route 소유다(JS 경계에서
  // Set 시맨틱 복원).
  if (hasSet(command.inputSchema, definitions) || hasSet(command.outputSchema, definitions)) {
    return false;
  }
  const inResult = collectPostcardFields(command.inputSchema, definitions);
  const outResult = collectPostcardFields(command.outputSchema, definitions);
  if (inResult.unsupported.length > 0 || outResult.unsupported.length > 0) return false;
  return collectNestedUnsupported(command, definitions).length === 0;
}

/**
 * Complex codecs use a recursive schema-driven wire and therefore cover the
 * shapes that the postcard fast path deliberately excludes. Cyclic references
 * are valid: the runtime depth limit, rather than code generation, bounds the
 * value. Unknown references and ambiguous unions remain Tier 3.
 */
function complexSchemaSupported(
  schema: import('./schema.js').JsonSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): boolean {
  return buildCodecIr(schema, definitions).ok;
}

function complexCodecSupported(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): boolean {
  return (
    !commandCodecSupported(command, definitions) &&
    complexSchemaSupported(command.inputSchema, definitions) &&
    complexSchemaSupported(command.outputSchema, definitions)
  );
}

/** Generate a schema-driven codec for commands outside the postcard subset. */
function generateComplexCodec(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string {
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  const outType = command.outputType === '()' ? 'void' : command.outputType;
  return (
    `/** route: complex-binary; RN uses native C++ when the schema is native-safe, otherwise JS. */\n` +
    `export const ${fnName}ComplexCodec: RkyvV2Codec<${inType}, ${outType}> = createComplexCodec<${inType}, ${outType}>({\n` +
    `  commandId: ${command.commandId},\n` +
    `  inputSchema: ${JSON.stringify(command.inputSchema)} as ComplexSchema,\n` +
    `  outputSchema: ${JSON.stringify(command.outputSchema)} as ComplexSchema,\n` +
    `  definitions: ${JSON.stringify(definitions)} as Record<string, ComplexSchema>,\n` +
    `});\n\n` +
    // Keep the historical generic codec name stable when a command moves from
    // postcard to complex-binary because of a wider schema shape.
    `export const ${fnName}Codec = ${fnName}ComplexCodec;\n\n`
  );
}

/**
 * 패키지 스키마에서 rkyv V2 레지스트리 파일(`rkyv-registry.ts`)을 생성합니다.
 *
 * 두 binary codec이 모두 지원하지 못하는 명령만 등록에서 제외된다 — 엔진의
 * Tier 3(JSON-in-binary) 폴백이 처리한다. 제외 시 표준 출력으로 WARN 을 낸다.
 */
export function generateRkyvRegistryTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const included: { command: CommandSchema; codec: string; route: 'postcard' | 'complex' }[] = [];
  const excluded: string[] = [];
  for (const c of schema.commands) {
    if (commandCodecSupported(c, definitions)) {
      included.push({
        command: c,
        codec: `${commandFunctionName(c.name)}Codec`,
        route: 'postcard',
      });
    } else if (complexCodecSupported(c, definitions)) {
      included.push({
        command: c,
        codec: `${commandFunctionName(c.name)}ComplexCodec`,
        route: 'complex',
      });
    } else {
      excluded.push(c.name);
      console.warn(
        `[rustra] WARN: command '${c.name}' has a schema unsupported by both the postcard and complex codecs; ` +
          `excluding from rkyv V2 registry — the engine will route it via Tier 3 JSON fallback.`,
      );
    }
  }

  const entries = included
    .map(({ command, codec, route }) => {
      return `  // route: ${route}\n  ['${command.name}', ${codec}]`;
    })
    .join(',\n');

  const codecImports = included.map(({ codec }) => codec).join(', ');

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
      return `${indent}w.push_i64(rustra_i64(rt, ${get}, "${field.name}"));`;
    case 'uvar':
      return `${indent}w.push_uvar(rustra_u64(rt, ${get}, "${field.name}"));`;
    case 'f64':
      return `${indent}w.push_f64(rustra_f64(rt, ${get}, "${field.name}"));`;
    case 'f32':
      return `${indent}w.push_f32(rustra_f32(rt, ${get}, "${field.name}"));`;
    case 'bool':
      return `${indent}{ auto _v = ${get}.getBool(); w.push_bool(_v); }`;
    case 'string':
      return `${indent}{ auto _v = ${get}.getString(rt).utf8(rt); w.push_string(_v); }`;
    case 'bytes': {
      // Vec<u8> — len varint + raw bytes. ArrayBuffer/Uint8Array 는 backing
      // buffer의 view 범위를 검증해 한 덩어리로 복사하고, number[]만 원소별
      // u8 검증을 유지한다. dedicated buffer capability가 없는 구 native
      // fallback도 동일한 공개 입력 계약을 지켜야 한다.
      return (
        `${indent}{ const auto& _v = ${get}; auto _o = _v.asObject(rt);` +
        ` if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt);` +
        ` w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]"); }` +
        ` else { auto _span = rustra_bytes(rt, _v, "${field.name}");` +
        ` w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }`
      );
    }
    case 'vec_zigzag':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) w.push_i64(rustra_i64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]")); }`
      );
    case 'vec_f64':
      return (
        `${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);` +
        ` auto _n = _arr.length(rt); w.push_uvar(_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) w.push_f64(rustra_f64(rt, _arr.getValueAtIndex(rt, _i), "${field.name}[]")); }`
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
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const pushVal =
        field.kind === 'map_zigzag'
          ? `w.push_i64(rustra_i64(rt, _e, "${field.name}{}"));`
          : field.kind === 'map_uvar'
            ? `w.push_uvar(rustra_u64(rt, _e, "${field.name}{}"));`
            : field.kind === 'map_f64'
              ? `w.push_f64(rustra_f64(rt, _e, "${field.name}{}"));`
              : field.kind === 'map_bool'
                ? 'w.push_bool(_e.getBool());'
                : 'w.push_string(_e.getString(rt).utf8(rt));';
      return (
        `${indent}{ auto _o = ${get}.asObject(rt);` +
        ` std::vector<std::pair<std::string, jsi::Value>> _entries;` +
        ` auto _names = _o.getPropertyNames(rt);` +
        ` for (size_t _j = 0; _j < _names.length(rt); _j++) { auto _k = _names.getValueAtIndex(rt, _j).getString(rt).utf8(rt);` +
        ` _entries.push_back({std::move(_k), _o.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_k.data()), _k.size()))}); }` +
        ` std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; });` +
        ` w.push_uvar(_entries.size());` +
        ` for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; ${pushVal} } }`
      );
    }
    case 'tuple': {
      // (A, B, …) — 무접두 나열. JS 측 표면은 고정 길이 배열.
      const items = field.tupleItems ?? [];
      const lines: string[] = [];
      lines.push(`${indent}{ auto _arr = ${get}.asObject(rt).getArray(rt);`);
      items.forEach((it, i) => {
        lines.push(
          cppEncodeWithGetter(it, `_arr.getValueAtIndex(rt, ${i})`, definitions, `${indent}  `),
        );
      });
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
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
    case 'option_uvar':
    case 'option_zigzag64':
    case 'option_uvar64':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct':
    case 'option_bytes': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_uvar: 'uvar',
          option_zigzag64: 'zigzag64',
          option_uvar64: 'uvar64',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
          option_bytes: 'bytes',
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
      const variantsCpp = `{${variants.map((variant) => JSON.stringify(variant)).join(',')}}`;
      return (
        `${indent}{ auto _s = ${get}.getString(rt).utf8(rt);` +
        ` const char* _variants[] = ${variantsCpp};` +
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
  // 정적 필드명은 cachedProp 으로 setProperty 한다 — 호출당 이름 변환 제거.
  // (스키마 식별자는 하이픈/공백 등을 이미 화이트리스트로 걸러 C++ 문자열
  // 리터럴로 안전하다.)
  const setProp = (val: string) =>
    `${indent}${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), ${val});`;
  switch (field.kind) {
    case 'zigzag':
      return setProp('(double)r.read_i64()');
    case 'uvar':
      return setProp('(double)r.read_uvar()');
    case 'f64':
      return setProp('r.read_f64()');
    case 'f32':
      return setProp('(double)r.read_f32()');
    case 'bool':
      return setProp('r.read_bool()');
    case 'string':
      return (
        `${indent}{ auto _s = r.read_string_view();` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::String::createFromUtf8(rt, _s.data, _s.size)); }`
      );
    case 'bytes': {
      // Vec<u8> → JS-owned ArrayBuffer. Reader/FFI 응답 수명과 JS 결과를
      // 분리하는 단 한 번의 memcpy이며 number[] 원소별 JSI 쓰기를 제거한다.
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _bytes = r.read_bytes_view((size_t)_n);` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), rustra::generated::make_array_buffer(rt, _bytes.data, _bytes.size)); }`
      );
    }
    case 'vec_zigzag':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, (double)r.read_i64()); }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`
      );
    case 'vec_f64':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_f64()); }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`
      );
    case 'vec_uvar':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, (double)r.read_uvar()); }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`
      );
    case 'vec_bool':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_bool()); }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`
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
      lines.push(
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _obj); }`,
      );
      return lines.join('\n');
    }
    case 'vec_string':
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _s = r.read_string_view();` +
        ` _arr.setValueAtIndex(rt, _i, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`
      );
    case 'map_zigzag':
    case 'map_uvar':
    case 'map_f64':
    case 'map_bool':
    case 'map_string': {
      const readVal =
        field.kind === 'map_zigzag'
          ? '_map.setProperty(rt, _k, (double)r.read_i64());'
          : field.kind === 'map_uvar'
            ? '_map.setProperty(rt, _k, (double)r.read_uvar());'
            : field.kind === 'map_f64'
              ? '_map.setProperty(rt, _k, r.read_f64());'
              : field.kind === 'map_bool'
                ? '_map.setProperty(rt, _k, r.read_bool());'
                : '{ auto _vs = r.read_string_view(); _map.setProperty(rt, _k, jsi::String::createFromUtf8(rt, _vs.data, _vs.size)); }';
      return (
        `${indent}{ auto _n = r.read_uvar(); auto _map = jsi::Object(rt);` +
        ` for (size_t _i = 0; _i < _n; _i++) { auto _ks = r.read_string_view();` +
        ` auto _k = jsi::String::createFromUtf8(rt, _ks.data, _ks.size);` +
        ` ${readVal} }` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), std::move(_map)); }`
      );
    }
    case 'tuple': {
      const items = field.tupleItems ?? [];
      const lines: string[] = [];
      lines.push(`${indent}{ auto _arr = jsi::Array(rt, ${items.length});`);
      items.forEach((it, i) => {
        // 요소 디코드는 임시 wrapper 객체 없이 배열 슬롯에 직접 심는다.
        lines.push(
          cppFieldDecodeExpr(
            { ...it, name: `${i}` } as PostcardField,
            `_arr_tmp_${i}`,
            definitions,
            `${indent}  `,
          ).replace(`_arr_tmp_${i}.setProperty(rt, "${i}"`, `_arr.setValueAtIndex(rt, ${i}`),
        );
      });
      lines.push(
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`,
      );
      return lines.join('\n');
    }
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
      lines.push(
        `${indent}  ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), _arr); }`,
      );
      return lines.join('\n');
    }
    case 'option_zigzag':
    case 'option_uvar':
    case 'option_zigzag64':
    case 'option_uvar64':
    case 'option_f64':
    case 'option_f32':
    case 'option_bool':
    case 'option_string':
    case 'option_struct':
    case 'option_bytes': {
      const innerKind = (
        {
          option_zigzag: 'zigzag',
          option_uvar: 'uvar',
          option_zigzag64: 'zigzag64',
          option_uvar64: 'uvar64',
          option_f64: 'f64',
          option_f32: 'f32',
          option_bool: 'bool',
          option_string: 'string',
          option_struct: 'struct',
          option_bytes: 'bytes',
        } as const
      )[field.kind];
      const innerField: PostcardField = { ...field, kind: innerKind };
      // Option 디코드: 태그 바이트 → None 이면 null, Some 이면 inner 디코드.
      // inner struct 디코드는 objExpr.setProperty 로 바로 심는다(임시 객체 없이).
      if (innerKind === 'struct') {
        return (
          `${indent}{ auto _tag = r.read_u8();` +
          ` if (_tag == 0) { ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::Value::null()); }` +
          ` else { ${cppFieldDecodeExpr(innerField, objExpr, definitions, '')} } }`
        );
      }
      const inner = cppFieldDecodeExpr(innerField, objExpr, definitions, '');
      // struct 외 inner(setProperty 한 줄) — 태그 분기 안에 넣는다.
      return `${indent}{ auto _tag = r.read_u8(); if (_tag == 0) { ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::Value::null()); } else { ${inner} } }`;
    }
    case 'enum_str': {
      const variants = field.enumVariants ?? [];
      const variantsCpp = `{${variants.map((variant) => JSON.stringify(variant)).join(',')}}`;
      return (
        `${indent}{ auto _idx = r.read_uvar(); const char* _variants[] = ${variantsCpp};` +
        ` if (_idx >= ${variants.length}) throw jsi::JSError(rt, "invalid enum index for ${field.name}");` +
        ` ${objExpr}.setProperty(rt, rustra::generated::cachedProp(rt, "${field.name}"), jsi::String::createFromAscii(rt, _variants[_idx])); }`
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

/**
 * (Tier 1) positional fast path가 다루는 스칼라 kind 집합.
 * facade(generatePositionalFacadeTs)와 C++ 코드젠(cppEncodePosCommand)이
 * 반드시 같은 집합을 써야 한다 — 어느 한쪽에만 포함된 kind는 facade가
 * callPos 로 노출한 명령을 C++ 이 인코딩하지 못해 런타임 JSError 가 난다.
 */
const POSITIONAL_SCALAR_KINDS = [
  'zigzag',
  'uvar',
  'f64',
  'f32',
  'bool',
  'string',
  'enum_str',
  'bytes',
] as const;

const RAW_SCALAR_KINDS = ['zigzag', 'uvar', 'f64', 'f32', 'bool'] as const;

/** Existing object-input commands that can safely forward one to three fields. */
function generatedFieldRoute(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField[] | null {
  if (command.inputType === '()') return null;
  const { fields } = collectPostcardFields(command.inputSchema, definitions);
  const positionalKinds = new Set<string>(POSITIONAL_SCALAR_KINDS);
  if (fields.length === 0 || fields.length > 3) return null;
  if (!fields.every((field) => positionalKinds.has(field.kind))) return null;
  return fields;
}

/** Dedicated native path is intentionally narrow: exactly one `Vec<u8>` field. */
function bufferCommandField(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): PostcardField | null {
  const fields = generatedFieldRoute(command, definitions);
  if (fields?.length !== 1 || fields[0].kind !== 'bytes') return null;
  const properties = command.inputSchema.properties;
  const required = command.inputSchema.required;
  if (
    !properties ||
    Object.keys(properties).length !== 1 ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== fields[0].name
  ) {
    return null;
  }
  return fields[0];
}

/** Direct raw-byte ABI requires one byte field on both sides of the command. */
function bufferCommandResultField(
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

type RawCommandShape = {
  inputFields: PostcardField[];
  outputField?: PostcardField;
};

/** Mirrors the Rust raw-handler eligibility contract for generated metadata. */
function rawCommandShape(
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
function cppEncodePosCommand(
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
        lines.push(`  w.push_i64(rustra_i64(rt, ${v}, "${f.name}"));`);
        break;
      case 'uvar':
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

// ── C++ complex codec generation ─────────────────────────────
//
// Complex JS codecs and this native codec use the same canonical IR. The
// generated C++ is intentionally specialized (there is no JSON parser in the
// RN binary) and keeps the original JSI object shape at the boundary.

type ComplexVariantIr = Extract<CodecIrNode, { kind: 'oneOf' }>['variants'][number];

function cppComplexName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function cppComplexEncodeName(name: string): string {
  return `complex_encode_ref_${cppComplexName(name)}`;
}

function cppComplexDecodeName(name: string): string {
  return `complex_decode_ref_${cppComplexName(name)}`;
}

function cppLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'jsi::Value::null()';
  if (typeof value === 'string') {
    const literal = JSON.stringify(value);
    return `jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(${literal}), sizeof(${literal}) - 1)`;
  }
  if (typeof value === 'boolean') return value ? 'jsi::Value(true)' : 'jsi::Value(false)';
  return `jsi::Value(${String(value)})`;
}

function cppLiteralPredicate(value: string, literal: string | number | boolean | null): string {
  if (literal === null) return `${value}.isNull()`;
  if (typeof literal === 'string') {
    const encoded = JSON.stringify(literal);
    return `${value}.isString() && ${value}.getString(rt).utf8(rt) == std::string(${encoded})`;
  }
  if (typeof literal === 'boolean') {
    return `${value}.isBool() && ${value}.getBool() == ${literal ? 'true' : 'false'}`;
  }
  return `${value}.isNumber() && ${value}.asNumber() == ${String(literal)}`;
}

function cppComplexNodePredicate(node: CodecIrNode, value: string): string {
  switch (node.kind) {
    case 'literal':
      return cppLiteralPredicate(value, node.value);
    case 'enum':
      return node.values.map((item) => cppLiteralPredicate(value, item)).join(' || ');
    case 'boolean':
      return `${value}.isBool()`;
    case 'integer':
    case 'number':
      return `${value}.isNumber()`;
    case 'string':
      return `${value}.isString()`;
    case 'null':
      return `${value}.isNull()`;
    case 'sequence':
    case 'tuple':
      return `${value}.isObject() && ${value}.asObject(rt).isArray(rt)`;
    case 'map':
    case 'struct':
    case 'ref':
    case 'oneOf':
      return `${value}.isObject() && !${value}.asObject(rt).isArray(rt)`;
    case 'optional':
      return `${value}.isNull() || ${cppComplexNodePredicate(node.inner, value)}`;
    case 'variant':
      return cppComplexNodePredicate(node.node, value);
  }
}

function cppComplexVariantPredicate(variant: ComplexVariantIr, value: string): string {
  if (variant.wrapper === 'value') return cppComplexNodePredicate(variant.node, value);
  if (variant.wrapper === 'property') {
    return `${value}.isObject() && ${value}.asObject(rt).hasProperty(rt, ${JSON.stringify(variant.property)})`;
  }
  if (variant.wrapper === 'discriminator' && variant.discriminator) {
    const property = `${value}.asObject(rt).getProperty(rt, ${JSON.stringify(variant.discriminator.key)})`;
    return `${value}.isObject() && ${cppLiteralPredicate(property, variant.discriminator.value)}`;
  }
  return cppComplexNodePredicate(variant.node, value);
}

type CppComplexState = { counter: number };

function cppComplexEncodeNode(
  node: CodecIrNode,
  value: string,
  indent: string,
  depth: string,
  state: CppComplexState,
): string[] {
  const next = () => `_cx${state.counter++}`;
  switch (node.kind) {
    case 'boolean':
      return [
        `${indent}if (!${value}.isBool()) throw jsi::JSError(rt, "complex boolean expected");`,
        `${indent}w.push_bool(${value}.getBool());`,
      ];
    case 'integer':
      return [
        `${indent}w.${node.format?.startsWith('uint') ? 'push_uvar(rustra_u64' : 'push_i64(rustra_i64'}(rt, ${value}, "complex integer"));`,
      ];
    case 'number':
      return [
        `${indent}w.${node.format === 'float' ? 'push_f32(rustra_f32' : 'push_f64(rustra_f64'}(rt, ${value}, "complex number"));`,
      ];
    case 'string':
      return [
        `${indent}if (!${value}.isString()) throw jsi::JSError(rt, "complex string expected");`,
        `${indent}w.push_string(${value}.getString(rt).utf8(rt));`,
      ];
    case 'null':
      return [`${indent}if (!${value}.isNull()) throw jsi::JSError(rt, "complex null expected");`];
    case 'literal':
      return [
        `${indent}if (!(${cppLiteralPredicate(value, node.value)})) throw jsi::JSError(rt, "complex literal mismatch");`,
      ];
    case 'enum': {
      const index = next();
      const lines = [`${indent}{ int ${index} = -1;`];
      node.values.forEach((item, itemIndex) => {
        lines.push(`${indent}  if (${cppLiteralPredicate(value, item)}) ${index} = ${itemIndex};`);
      });
      lines.push(
        `${indent}  if (${index} < 0) throw jsi::JSError(rt, "complex enum value mismatch");`,
        `${indent}  w.push_uvar(static_cast<uint64_t>(${index})); }`,
      );
      return lines;
    }
    case 'ref':
      return [`${indent}${cppComplexEncodeName(node.name)}(rt, ${value}, w, ${depth});`];
    case 'optional':
      return [
        `${indent}{ if (${value}.isNull() || ${value}.isUndefined()) { w.push_u8(0); } else { w.push_u8(1);`,
        ...cppComplexEncodeNode(node.inner, value, `${indent}  `, `${depth} + 1`, state),
        `${indent}} }`,
      ];
    case 'sequence': {
      const object = next();
      const array = next();
      const length = next();
      const lines = [
        `${indent}{ auto ${object} = ${value}.asObject(rt);`,
        `${indent}  if (!${value}.isObject() || !${object}.isArray(rt)) throw jsi::JSError(rt, "complex array expected");`,
        `${indent}  auto ${array} = ${object}.getArray(rt); auto ${length} = ${array}.length(rt);`,
        `${indent}  w.push_uvar(${length});`,
        `${indent}  for (size_t _i = 0; _i < ${length}; _i++) {`,
        ...cppComplexEncodeNode(
          node.item,
          `${array}.getValueAtIndex(rt, _i)`,
          `${indent}    `,
          `${depth} + 1`,
          state,
        ),
        `${indent}  } }`,
      ];
      if (node.unique) {
        lines.splice(
          1,
          1,
          `${indent}  throw jsi::JSError(rt, "complex native codec requires an Array; use JS codec for Set");`,
        );
      }
      return lines;
    }
    case 'tuple': {
      const object = next();
      const array = next();
      const lines = [
        `${indent}{ auto ${object} = ${value}.asObject(rt);`,
        `${indent}  if (!${value}.isObject() || !${object}.isArray(rt) || ${object}.getArray(rt).length(rt) != ${node.items.length}) throw jsi::JSError(rt, "complex tuple length mismatch");`,
        `${indent}  auto ${array} = ${object}.getArray(rt); w.push_uvar(${node.items.length});`,
      ];
      node.items.forEach((item, index) => {
        lines.push(
          ...cppComplexEncodeNode(
            item,
            `${array}.getValueAtIndex(rt, ${index})`,
            `${indent}  `,
            `${depth} + 1`,
            state,
          ),
        );
      });
      lines.push(`${indent}}`);
      return lines;
    }
    case 'map': {
      const object = next();
      const names = next();
      const entries = next();
      return [
        `${indent}{ if (!${value}.isObject() || ${value}.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object map expected");`,
        `${indent}  auto ${object} = ${value}.asObject(rt); auto ${names} = ${object}.getPropertyNames(rt);`,
        `${indent}  std::vector<std::pair<std::string, jsi::Value>> ${entries};`,
        `${indent}  for (size_t _i = 0; _i < ${names}.length(rt); _i++) { auto _key = ${names}.getValueAtIndex(rt, _i).getString(rt).utf8(rt); auto _property = ${object}.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_key.data()), _key.size())); ${entries}.push_back({_key, std::move(_property)}); }`,
        `${indent}  std::sort(${entries}.begin(), ${entries}.end(), [](const auto& _a, const auto& _b) { const auto& a = _a.first; const auto& b = _b.first; const size_t n = std::min(a.size(), b.size()); for (size_t i = 0; i < n; ++i) { const auto ca = static_cast<unsigned char>(a[i]); const auto cb = static_cast<unsigned char>(b[i]); if (ca != cb) return ca < cb; } return a.size() < b.size(); });`,
        `${indent}  w.push_uvar(${entries}.size()); for (auto& _entry : ${entries}) { w.push_string(_entry.first); auto& _value = _entry.second;`,
        ...cppComplexEncodeNode(node.value, '_value', `${indent}    `, `${depth} + 1`, state),
        `${indent}  } }`,
      ];
    }
    case 'struct': {
      const object = next();
      const lines = [
        `${indent}{ if (!${value}.isObject() || ${value}.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");`,
        `${indent}  auto ${object} = ${value}.asObject(rt);`,
      ];
      for (const field of node.fields) {
        const fieldValue = next();
        const property = JSON.stringify(field.name);
        if (field.optional) {
          lines.push(
            `${indent}  auto ${fieldValue} = ${object}.getProperty(rt, ${property}); if (${object}.hasProperty(rt, ${property}) && !${fieldValue}.isUndefined()) { w.push_u8(1);`,
            ...cppComplexEncodeNode(field.node, fieldValue, `${indent}    `, `${depth} + 1`, state),
            `${indent}  } else { w.push_u8(0); }`,
          );
        } else {
          lines.push(
            `${indent}  auto ${fieldValue} = ${object}.getProperty(rt, ${property});`,
            ...cppComplexEncodeNode(field.node, fieldValue, `${indent}  `, `${depth} + 1`, state),
          );
        }
      }
      lines.push(`${indent}}`);
      return lines;
    }
    case 'oneOf': {
      const index = next();
      const lines = [`${indent}{ int ${index} = -1;`];
      node.variants.forEach((variant, variantIndex) => {
        lines.push(
          `${indent}  if (${cppComplexVariantPredicate(variant, value)}) ${index} = ${variantIndex};`,
        );
      });
      lines.push(
        `${indent}  if (${index} < 0) throw jsi::JSError(rt, "complex oneOf value mismatch");`,
        `${indent}  w.push_uvar(static_cast<uint64_t>(${index}));`,
      );
      node.variants.forEach((variant, variantIndex) => {
        lines.push(`${indent}  if (${index} == ${variantIndex}) {`);
        if (variant.wrapper === 'property' && variant.property) {
          const object = next();
          lines.push(
            `${indent}    auto ${object} = ${value}.asObject(rt);`,
            ...cppComplexEncodeNode(
              variant.node,
              `${object}.getProperty(rt, ${JSON.stringify(variant.property)})`,
              `${indent}    `,
              `${depth} + 1`,
              state,
            ),
          );
        } else {
          lines.push(
            ...cppComplexEncodeNode(variant.node, value, `${indent}    `, `${depth} + 1`, state),
          );
        }
        lines.push(`${indent}  }`);
      });
      lines.push(`${indent}}`);
      return lines;
    }
    case 'variant':
      return cppComplexEncodeNode(node.node, value, indent, depth, state);
  }
}

function cppComplexDecodeExpr(node: CodecIrNode, depth: string, state: CppComplexState): string {
  const next = () => `_cx${state.counter++}`;
  switch (node.kind) {
    case 'boolean':
      return 'jsi::Value(r.read_bool())';
    case 'integer':
      return node.format?.startsWith('uint')
        ? 'jsi::Value(static_cast<double>(r.read_uvar()))'
        : 'jsi::Value(static_cast<double>(r.read_i64()))';
    case 'number':
      return node.format === 'float'
        ? 'jsi::Value(static_cast<double>(r.read_f32()))'
        : 'jsi::Value(r.read_f64())';
    case 'string':
      return `[&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()`;
    case 'null':
      return 'jsi::Value::null()';
    case 'literal':
      return cppLiteral(node.value);
    case 'enum': {
      const index = next();
      const lines = [`[&]() -> jsi::Value { auto ${index} = r.read_uvar();`];
      node.values.forEach((value, valueIndex) => {
        lines.push(` if (${index} == ${valueIndex}) return ${cppLiteral(value)};`);
      });
      lines.push(' throw std::runtime_error("complex enum index out of range"); }()');
      return lines.join('');
    }
    case 'ref':
      return `${cppComplexDecodeName(node.name)}(rt, r, ${depth})`;
    case 'optional': {
      const tag = next();
      return `[&]() -> jsi::Value { auto ${tag} = r.read_u8(); if (${tag} == 0) return jsi::Value::null(); if (${tag} != 1) throw std::runtime_error("complex optional presence tag"); return ${cppComplexDecodeExpr(node.inner, `${depth} + 1`, state)}; }()`;
    }
    case 'sequence': {
      if (node.unique)
        return '([&]() -> jsi::Value { throw std::runtime_error("complex native codec does not decode Set"); }())';
      const length = next();
      const array = next();
      return `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto ${array} = jsi::Array(rt, static_cast<size_t>(${length})); for (size_t _i = 0; _i < ${length}; _i++) ${array}.setValueAtIndex(rt, _i, ${cppComplexDecodeExpr(node.item, `${depth} + 1`, state)}); return ${array}; }()`;
    }
    case 'tuple': {
      const length = next();
      const array = next();
      const lines = [
        `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} != ${node.items.length}) throw std::runtime_error("complex tuple length mismatch"); auto ${array} = jsi::Array(rt, ${node.items.length});`,
      ];
      node.items.forEach((item, index) => {
        lines.push(
          `${array}.setValueAtIndex(rt, ${index}, ${cppComplexDecodeExpr(item, `${depth} + 1`, state)});`,
        );
      });
      lines.push(`return ${array}; }()`);
      return lines.join(' ');
    }
    case 'map': {
      const length = next();
      const object = next();
      const key = next();
      return `[&]() -> jsi::Value { auto ${length} = r.read_uvar(); if (${length} > 100000) throw std::runtime_error("complex map length exceeds 100000"); auto ${object} = jsi::Object(rt); for (size_t _i = 0; _i < ${length}; _i++) { auto ${key} = r.read_string_view(); auto _keyValue = jsi::String::createFromUtf8(rt, ${key}.data, ${key}.size); ${object}.setProperty(rt, _keyValue, ${cppComplexDecodeExpr(node.value, `${depth} + 1`, state)}); } return ${object}; }()`;
    }
    case 'struct': {
      const object = next();
      const lines = [`[&]() -> jsi::Value { auto ${object} = jsi::Object(rt);`];
      for (const field of node.fields) {
        const property = JSON.stringify(field.name);
        const value = cppComplexDecodeExpr(field.node, `${depth} + 1`, state);
        if (field.optional) {
          const tag = next();
          lines.push(
            ` auto ${tag} = r.read_u8(); if (${tag} > 1) throw std::runtime_error("complex optional field presence tag"); if (${tag} == 1) ${object}.setProperty(rt, ${property}, ${value});`,
          );
        } else {
          lines.push(` ${object}.setProperty(rt, ${property}, ${value});`);
        }
      }
      lines.push(` return ${object}; }()`);
      return lines.join('');
    }
    case 'oneOf': {
      const index = next();
      const lines = [`[&]() -> jsi::Value { auto ${index} = r.read_uvar();`];
      node.variants.forEach((variant, variantIndex) => {
        let value = cppComplexDecodeExpr(variant.node, `${depth} + 1`, state);
        if (variant.wrapper === 'property' && variant.property) {
          const object = next();
          value = `[&]() -> jsi::Value { auto ${object} = jsi::Object(rt); ${object}.setProperty(rt, ${JSON.stringify(variant.property)}, ${value}); return ${object}; }()`;
        } else if (variant.wrapper === 'discriminator' && variant.discriminator) {
          const decoded = next();
          const object = next();
          value = `[&]() -> jsi::Value { auto ${decoded} = ${value}; auto ${object} = ${decoded}.asObject(rt); ${object}.setProperty(rt, ${JSON.stringify(variant.discriminator.key)}, ${cppLiteral(variant.discriminator.value)}); return ${object}; }()`;
        }
        lines.push(` if (${index} == ${variantIndex}) return ${value};`);
      });
      lines.push(' throw std::runtime_error("complex oneOf index out of range"); }()');
      return lines.join('');
    }
    case 'variant':
      return cppComplexDecodeExpr(node.node, depth, state);
  }
}

function cppComplexNativeSupported(
  node: CodecIrNode,
  definitions: Record<string, import('./schema.js').JsonSchema>,
  seen = new Set<string>(),
): boolean {
  switch (node.kind) {
    case 'integer':
      // int64/uint64 는 계속 C++ 정적 코덱 제외 — Hermes JSI bigint 전달 검증은
      // 트랙 B1 스파이크 과제다(TS postcard fast-path 게이트 해제와 무관).
      return node.format !== 'int64' && node.format !== 'uint64';
    case 'sequence':
      return !node.unique && cppComplexNativeSupported(node.item, definitions, seen);
    case 'tuple':
      return node.items.every((item) => cppComplexNativeSupported(item, definitions, seen));
    case 'map':
      return cppComplexNativeSupported(node.value, definitions, seen);
    case 'struct':
      return node.fields.every((field) => cppComplexNativeSupported(field.node, definitions, seen));
    case 'optional':
      return cppComplexNativeSupported(node.inner, definitions, seen);
    case 'oneOf':
      return node.variants.every((variant) =>
        cppComplexNativeSupported(variant.node, definitions, seen),
      );
    case 'ref':
      if (seen.has(node.name)) return true;
      {
        const definition = definitions[node.name];
        const result = definition
          ? buildCodecIr(definition, definitions)
          : { ok: false as const, reason: 'missing definition' };
        if (!result.ok) return false;
        const nextSeen = new Set(seen);
        nextSeen.add(node.name);
        return cppComplexNativeSupported(result.node, definitions, nextSeen);
      }
    case 'variant':
      return cppComplexNativeSupported(node.node, definitions, seen);
    default:
      return true;
  }
}

function cppComplexEncodeCommand(command: CommandSchema, input: CodecIrNode): string {
  const fnName = commandFunctionName(command.name);
  const state: CppComplexState = { counter: 0 };
  const lines = [
    `static void encode_complex_${fnName}(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {`,
    `  w.push_u8(${command.commandId & 0xff}); w.push_u8(${(command.commandId >> 8) & 0xff});`,
    ...cppComplexEncodeNode(input, 'args', '  ', '0', state),
    `}`,
  ];
  return lines.join('\n') + '\n';
}

function cppComplexDecodeCommand(command: CommandSchema, output: CodecIrNode): string {
  const fnName = commandFunctionName(command.name);
  const state: CppComplexState = { counter: 0 };
  return (
    [
      `static jsi::Value decode_complex_${fnName}(jsi::Runtime& rt, rc::Reader& r) {`,
      ...[`  return ${cppComplexDecodeExpr(output, '0', state)};`],
      `}`,
    ].join('\n') + '\n'
  );
}

function cppComplexRefFunctions(
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
    );
    declarations.push(
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
      `}`,
      `static jsi::Value ${cppComplexDecodeName(name)}(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return ${cppComplexDecodeExpr(result.node, '_depth', decodeState)}; }`,
    );
  }
  return { declarations, definitions: bodies };
}

/**
 * 패키지 스키마에서 C++ codec 헤더(`rustra-generated-codecs.hpp`)를 생성한다.
 * RN JSI bridge(RustraJSIBridge.cpp)가 include 하여 encode_by_name/decode_by_name 호출.
 */
export function generateRkyvCodecsHpp(_schema: PackageSchema): string {
  return (
    `// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.\n` +
    `// C++ postcard codec for the RN JSI fast path (B1).\n` +
    `// C++는 postcard subset과 Set을 제외한 complex subset을 직접 인코딩/디코딩한다.\n` +
    `// Set을 포함한 complex 명령은 JS codec이 invokeRkyvV2로 전달하고, 동적 명령은\n` +
    `// JS Tier 3 fallback을 사용한다.\n` +
    `#pragma once\n\n` +
    `#include <cstddef>\n` +
    `#include <cstdint>\n` +
    `#include <jsi/jsi.h>\n` +
    `#include <string>\n` +
    `#include "rustra-codec.hpp"\n\n` +
    `namespace rustra::generated {\n\n` +
    `/// 정적 필드명 PropNameID 캐시 조회(decode 핫패스 — 호출당 이름 변환 제거).\n` +
    `/// 캐시는 Runtime global 의 NativeState 가 소유하므로 RN reload 때 이전\n` +
    `/// Runtime 과 함께, 아직 Runtime API가 유효한 시점에 폐기된다.\n` +
    `const facebook::jsi::PropNameID& cachedProp(facebook::jsi::Runtime& rt,\n` +
    `                                           const char* name);\n\n` +
    `/// 응답 byte span을 새 JS-owned ArrayBuffer로 복사한다. 브릿지 호스트 구현.\n` +
    `facebook::jsi::Value make_array_buffer(facebook::jsi::Runtime& rt,\n` +
    `                                      const uint8_t* data, size_t size);\n\n` +
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
    `/// codegen 시점에 알려진 정적 명령 id 집합(capability 협상용).\n` +
    `bool has_static_codec_id(uint16_t cmd_id);\n\n` +
    `/// (Tier 1) positional 인자 직접 인코딩 가능한 cmd_id 여부.\n` +
    `bool has_pos_codec(uint16_t cmd_id);\n\n` +
    `/// 입력과 출력이 각각 정확히 하나의 Vec<u8> 필드인 cmd_id 여부.\n` +
    `bool has_buffer_codec(uint16_t cmd_id);\n\n` +
    `/// direct Rust byte 결과를 생성된 공개 출력 객체로 복원한다.\n` +
    `facebook::jsi::Value decode_buffer_result_by_id(facebook::jsi::Runtime& rt,\n` +
    `                                                uint16_t cmd_id,\n` +
    `                                                facebook::jsi::Value buffer);\n\n` +
    `/// 빌린 byte span을 즉시 postcard Writer로 복사한다.\n` +
    `void encode_buffer_by_id(uint16_t cmd_id, const uint8_t* data, size_t size,\n` +
    `                         rustra::codec::Writer& w);\n\n` +
    `/// (Tier 1) 개별 Value 인자 → postcard 바이트 (invokeTypedPos 진입).\n` +
    `/// argc 일치는 호출부(RustraJSIBridge)가 검증한다. 미발견 시 JSError.\n` +
    `void encode_pos_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n` +
    `                      const facebook::jsi::Value* argv, size_t argc,\n` +
    `                      rustra::codec::Writer& w);\n\n` +
    `/// (Tier 0) raw scalar 결과를 생성된 공개 출력 shape로 복원 가능한 id.\n` +
    `bool has_raw_codec(uint16_t cmd_id);\n\n` +
    `/// (Tier 0) 개별 JSI 필드를 스키마 종류에 맞는 u64 슬롯으로 변환.\n` +
    `void encode_raw_slots(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n` +
    `                      const facebook::jsi::Value* argv, size_t argc,\n` +
    `                      uint64_t* slots);\n\n` +
    `/// (Tier 0) Rust raw u64 결과 슬롯을 공개 JSI 출력 shape로 복원.\n` +
    `facebook::jsi::Value decode_raw_result(facebook::jsi::Runtime& rt,\n` +
    `                                       uint16_t cmd_id, uint64_t slot);\n\n` +
    `} // namespace rustra::generated\n`
  );
}

/**
 * 패키지 스키마에서 C++ codec 구현(`rustra-generated-codecs.cpp`)을 생성한다.
 * postcard 코덱과 Set 없는 complex 코덱 지원 명령을 디스패치에 포함한다.
 * Set을 포함한 complex 명령은 TS registry에 남기고 C++에서는 정적 코덱을
 * 광고하지 않아 JS complex route를 탄다. 양쪽 binary codec이 모두 미지원인
 * 명령만 JS 엔진이 Tier 3로 라우팅한다.
 */
export function generateRkyvCodecsCpp(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  // C++ 정적 postcard 코덱은 uvar64/zigzag64 kind 를 emit 하지 않는다(트랙 B —
  // Hermes JSI bigint 검증 전까지). TS 쪽에선 postcard 로 승격된 와이드 정수
  // 명령을 여기서 다시 걸러 C++ 정적 코덱 광고 대상에서 제외한다 — 그래야 RN
  // 엔진이 JS 코덱 폴백을 쓴다(무음 왜곡/와이어 불일치 방지).
  const cppSafe = (c: CommandSchema) =>
    !hasWideIntegerField(c.inputSchema, definitions) &&
    !hasWideIntegerField(c.outputSchema, definitions);
  const supported = schema.commands.filter(
    (c) => commandCodecSupported(c, definitions) && cppSafe(c),
  );
  const complexSupported = schema.commands
    .map((command) => {
      if (commandCodecSupported(command, definitions)) return null;
      const input = buildCodecIr(command.inputSchema, definitions);
      const output = buildCodecIr(command.outputSchema, definitions);
      if (!input.ok || !output.ok) return null;
      if (
        !cppComplexNativeSupported(input.node, definitions) ||
        !cppComplexNativeSupported(output.node, definitions)
      )
        return null;
      return { command, input: input.node, output: output.node };
    })
    .filter(
      (entry): entry is { command: CommandSchema; input: CodecIrNode; output: CodecIrNode } =>
        entry !== null,
    );
  const staticCommands = [
    ...supported.map((command) => ({ command, route: 'postcard' as const })),
    ...complexSupported.map(({ command }) => ({ command, route: 'complex' as const })),
  ];
  const encodeCases = staticCommands
    .map((c) => {
      const fn = commandFunctionName(c.command.name);
      const encoder = c.route === 'complex' ? `encode_complex_${fn}` : `encode_${fn}`;
      return `  if (name == "${c.command.name}") { ${encoder}(rt, args, w); return true; }`;
    })
    .join('\n');
  const decodeCases = staticCommands
    .map((c) => {
      const fn = commandFunctionName(c.command.name);
      const decoder = c.route === 'complex' ? `decode_complex_${fn}` : `decode_${fn}`;
      return `  if (name == "${c.command.name}") return ${decoder}(rt, r);`;
    })
    .join('\n');
  const hasCases = staticCommands
    .map((c) => `  if (name == "${c.command.name}") return true;`)
    .join('\n');
  // by_id 디스패치 (P0-3) — switch 문으로 u16 cmd_id 를 직접 분기한다.
  // 이름 비교체인(encode_by_name)과 동일한 per-command 함수를 재사용하므로
  // 바이트 출력은 항상 동일하다.
  const encodeIdCases = staticCommands
    .map(
      (c) =>
        `    case ${c.command.commandId}: ${c.route === 'complex' ? 'encode_complex_' : 'encode_'}${commandFunctionName(c.command.name)}(rt, args, w); return true;`,
    )
    .join('\n');
  const decodeIdCases = staticCommands
    .map(
      (c) =>
        `    case ${c.command.commandId}: return ${c.route === 'complex' ? 'decode_complex_' : 'decode_'}${commandFunctionName(c.command.name)}(rt, r);`,
    )
    .join('\n');
  const staticIdCases = staticCommands
    .map((c) => `    case ${c.command.commandId}: return true;`)
    .join('\n');
  const posCommands = supported
    .map((c) => ({ cmd: c, code: cppEncodePosCommand(c, definitions) }))
    .filter((x): x is { cmd: CommandSchema; code: string } => x.code !== null);
  const bufferInputCommands = supported.filter((command) =>
    bufferCommandField(command, definitions),
  );
  const bufferCommands = supported
    .map((cmd) => ({ cmd, output: bufferCommandResultField(cmd, definitions) }))
    .filter(
      (entry): entry is { cmd: CommandSchema; output: PostcardField } => entry.output !== null,
    );
  const rawCommands = supported
    .map((cmd) => ({ cmd, shape: rawCommandShape(cmd, definitions) }))
    .filter(
      (entry): entry is { cmd: CommandSchema; shape: RawCommandShape } => entry.shape !== null,
    );

  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.`);
  lines.push(`// C++ postcard codec for the RN JSI fast path (B1).`);
  lines.push(`#include "rustra-generated-codecs.hpp"`);
  lines.push(`#include <cmath>`);
  lines.push(`#include <cstring>`);
  lines.push(`#include <jsi/jsi.h>`);
  lines.push(`#include <limits>`);
  lines.push(`#include <memory>`);
  lines.push(`#include <stdexcept>`);
  lines.push(`#include <string>`);
  lines.push(`#include <unordered_map>`);
  lines.push(`#include <utility>`);
  lines.push(``);
  lines.push(`using namespace facebook::jsi;`);
  // 명시적 `jsi::` 한정자(generated codec bodies) 를 위한 별칭 — RN Pods 의
  // jsi.h 는 `namespace jsi` 를 facebook:: 내부에만 연다.
  lines.push(`namespace jsi = facebook::jsi;`);
  lines.push(`namespace rc = rustra::codec;`);
  lines.push(``);
  // 정적 필드명 PropNameID 캐시 — jsi::Object::setProperty(문자열) 는 호출마다
  // Hermes 내부에서 이름 변환을 수행할 수 있다. decode 핫패스의 프로퍼티 이름은
  // 컴파일 타임 상수이므로 변환을 최초 1회로 고정한다. 캐시를 일반 process static
  // 값으로 소유하면 RN reload 뒤 이미 파괴된 Runtime 을 통해 PropNameID 소멸자가
  // 실행돼 SIGSEGV가 난다. 실제 JSI에서는 Runtime global NativeState가 소유하고,
  // static map은 weak_ptr만 보관해 Runtime 수명에 캐시 수명을 결박한다.
  lines.push(`namespace rustra { namespace generated {`);
  lines.push(`#ifdef RUSTRA_TEST_JSI_SHIM`);
  lines.push(`  using RuntimePropNameCache = std::unordered_map<std::string, jsi::PropNameID>;`);
  lines.push(`  std::shared_ptr<RuntimePropNameCache> runtimePropNameCache(jsi::Runtime&) {`);
  lines.push(`    static auto cache = std::make_shared<RuntimePropNameCache>();`);
  lines.push(`    return cache;`);
  lines.push(`  }`);
  lines.push(`#else`);
  lines.push(`  class RuntimePropNameCache final : public jsi::NativeState {`);
  lines.push(`  public:`);
  lines.push(`    std::unordered_map<std::string, jsi::PropNameID> values;`);
  lines.push(`  };`);
  lines.push(`  std::shared_ptr<RuntimePropNameCache> runtimePropNameCache(jsi::Runtime& rt) {`);
  lines.push(
    `    static std::unordered_map<jsi::Runtime*, std::weak_ptr<RuntimePropNameCache>> caches;`,
  );
  lines.push(`    auto found = caches.find(&rt);`);
  lines.push(`    if (found != caches.end()) {`);
  lines.push(`      if (auto cache = found->second.lock()) return cache;`);
  lines.push(`    }`);
  lines.push(`    auto cache = std::make_shared<RuntimePropNameCache>();`);
  lines.push(`    jsi::Object holder(rt);`);
  lines.push(`    holder.setNativeState(rt, cache);`);
  lines.push(`    rt.global().setProperty(rt, "__rustraPropNameCache", std::move(holder));`);
  lines.push(`    caches[&rt] = cache;`);
  lines.push(`    return cache;`);
  lines.push(`  }`);
  lines.push(`#endif`);
  lines.push(`  const jsi::PropNameID& cachedProp(jsi::Runtime& rt, const char* name) {`);
  lines.push(`    auto cache = runtimePropNameCache(rt);`);
  lines.push(`#ifdef RUSTRA_TEST_JSI_SHIM`);
  lines.push(`    auto& values = *cache;`);
  lines.push(`#else`);
  lines.push(`    auto& values = cache->values;`);
  lines.push(`#endif`);
  lines.push(`    auto it = values.find(name);`);
  lines.push(`    if (it == values.end()) {`);
  lines.push(`      it = values.emplace(name, jsi::PropNameID::forAscii(rt, name)).first;`);
  lines.push(`    }`);
  lines.push(`    return it->second;`);
  lines.push(`  }`);
  lines.push(`}}`);
  lines.push(``);
  lines.push(
    `[[maybe_unused]] static double rustra_f64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");`,
  );
  lines.push(`  double number = value.asNumber();`);
  lines.push(
    `  if (!std::isfinite(number)) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be finite");`,
  );
  lines.push(`  return number;`);
  lines.push(`}`);
  lines.push(
    `[[maybe_unused]] static int64_t rustra_i64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(`  double number = rustra_f64(rt, value, field);`);
  lines.push(`  constexpr double maxSafe = 9007199254740991.0;`);
  lines.push(`  if (std::trunc(number) != number || number < -maxSafe || number > maxSafe)`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a safe integer");`,
  );
  lines.push(`  return static_cast<int64_t>(number);`);
  lines.push(`}`);
  lines.push(
    `[[maybe_unused]] static uint64_t rustra_u64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(`  double number = rustra_f64(rt, value, field);`);
  lines.push(`  constexpr double maxSafe = 9007199254740991.0;`);
  lines.push(`  if (std::trunc(number) != number || number < 0.0 || number > maxSafe)`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a non-negative safe integer");`,
  );
  lines.push(`  return static_cast<uint64_t>(number);`);
  lines.push(`}`);
  lines.push(
    `[[maybe_unused]] static uint8_t rustra_u8(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");`,
  );
  lines.push(`  double number = value.asNumber();`);
  lines.push(`  if (!(number >= 0.0 && number <= 255.0))`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");`,
  );
  lines.push(`  uint8_t byte = static_cast<uint8_t>(number);`);
  lines.push(`  if (static_cast<double>(byte) != number)`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");`,
  );
  lines.push(`  return byte;`);
  lines.push(`}`);
  lines.push(`struct RustraByteSpan { const uint8_t* data; size_t size; };`);
  lines.push(
    `[[maybe_unused]] static RustraByteSpan rustra_bytes(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(`  if (!value.isObject())`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray, ArrayBuffer, or number[]");`,
  );
  lines.push(`  auto object = value.asObject(rt);`);
  lines.push(`  if (object.isArrayBuffer(rt)) {`);
  lines.push(`    auto buffer = object.getArrayBuffer(rt);`);
  lines.push(`    auto size = buffer.length(rt);`);
  lines.push(`    auto* data = buffer.data(rt);`);
  lines.push(`    if (size > 0 && data == nullptr)`);
  lines.push(
    `      throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached ArrayBuffer storage");`,
  );
  lines.push(`    return {data, size};`);
  lines.push(`  }`);
  lines.push(`  auto bytesPerElement = object.getProperty(rt, "BYTES_PER_ELEMENT");`);
  lines.push(`  auto bufferValue = object.getProperty(rt, "buffer");`);
  lines.push(`  auto offsetValue = object.getProperty(rt, "byteOffset");`);
  lines.push(`  auto lengthValue = object.getProperty(rt, "byteLength");`);
  lines.push(
    `  if (!bytesPerElement.isNumber() || bytesPerElement.asNumber() != 1.0 || !bufferValue.isObject() || !bufferValue.asObject(rt).isArrayBuffer(rt) || !offsetValue.isNumber() || !lengthValue.isNumber())`,
  );
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray or ArrayBuffer");`,
  );
  lines.push(`  auto buffer = bufferValue.asObject(rt).getArrayBuffer(rt);`);
  lines.push(`  auto bufferSize = buffer.length(rt);`);
  lines.push(`  double offsetNumber = offsetValue.asNumber();`);
  lines.push(`  double lengthNumber = lengthValue.asNumber();`);
  lines.push(
    `  if (!std::isfinite(offsetNumber) || !std::isfinite(lengthNumber) || std::trunc(offsetNumber) != offsetNumber || std::trunc(lengthNumber) != lengthNumber || offsetNumber < 0.0 || lengthNumber < 0.0 || offsetNumber > static_cast<double>(bufferSize) || lengthNumber > static_cast<double>(bufferSize) - offsetNumber)`,
  );
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' view is outside its ArrayBuffer");`,
  );
  lines.push(`  auto offset = static_cast<size_t>(offsetNumber);`);
  lines.push(`  auto size = static_cast<size_t>(lengthNumber);`);
  lines.push(`  auto* data = buffer.data(rt);`);
  lines.push(`  if (bufferSize > 0 && data == nullptr)`);
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached TypedArray storage");`,
  );
  lines.push(`  return {size == 0 ? data : data + offset, size};`);
  lines.push(`}`);
  lines.push(
    `[[maybe_unused]] static float rustra_f32(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(`  double number = rustra_f64(rt, value, field);`);
  lines.push(
    `  if (number < -std::numeric_limits<float>::max() || number > std::numeric_limits<float>::max())`,
  );
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' is outside the f32 range");`,
  );
  lines.push(`  return static_cast<float>(number);`);
  lines.push(`}`);
  lines.push(``);
  const complexRefs = new Set(Object.keys(definitions));
  const refFunctions = cppComplexRefFunctions(definitions, complexRefs);
  lines.push(...refFunctions.declarations);
  lines.push(``);
  lines.push(...refFunctions.definitions);
  for (const command of supported) {
    lines.push(cppEncodeCommand(command, definitions));
    const pos = cppEncodePosCommand(command, definitions);
    if (pos) lines.push(pos);
    lines.push(cppDecodeCommand(command, definitions));
  }
  for (const { command, input, output } of complexSupported) {
    lines.push(cppComplexEncodeCommand(command, input));
    lines.push(cppComplexDecodeCommand(command, output));
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
  lines.push(`bool has_static_codec_id(uint16_t cmd_id) {`);
  lines.push(`  switch (cmd_id) {`);
  lines.push(staticIdCases);
  lines.push(`    default: return false;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  // (Tier 1) positional encode dispatch — invokeTypedPos(cmdId, a, b, …) 진입이
  // cmd_id 로 직접 분기. 조건 미충족(필드 4+/배열 등) 명령은 목록에 없다 —
  // JS 엔진이 invokeTypedById 로 폴백한다.
  lines.push(`/// (Tier 1) positional 인자를 직접 인코딩 가능한 cmd_id 집합 — JS 폴백 판별용.`);
  lines.push(`bool has_pos_codec(uint16_t cmd_id) {`);
  lines.push(posCommands.map((x) => `  if (cmd_id == ${x.cmd.commandId}) return true;`).join('\n'));
  lines.push(`  return false;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `/// (Tier 1) 개별 Value 인자 → postcard 바이트. 명령별 코덱이 argc를 정확히 검증한다.`,
  );
  lines.push(
    `void encode_pos_by_id(jsi::Runtime& rt, uint16_t cmd_id, const jsi::Value* argv, size_t argc, rc::Writer& w) {`,
  );
  lines.push(`  switch (cmd_id) {`);
  lines.push(
    posCommands
      .map(
        (x) =>
          `    case ${x.cmd.commandId}: encode_pos_${commandFunctionName(x.cmd.name)}(rt, argv, argc, w); return;`,
      )
      .join('\n'),
  );
  lines.push(
    `    default: throw JSError(rt, "rustra: no positional codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`bool has_buffer_codec(uint16_t cmd_id) {`);
  lines.push(`  switch (cmd_id) {`);
  lines.push(bufferCommands.map(({ cmd }) => `    case ${cmd.commandId}: return true;`).join('\n'));
  lines.push(`    default: return false;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `void encode_buffer_by_id(uint16_t cmd_id, const uint8_t* data, size_t size, rc::Writer& w) {`,
  );
  lines.push(
    `  if (size > 0 && data == nullptr) throw std::invalid_argument("rustra: null byte buffer");`,
  );
  lines.push(`  switch (cmd_id) {`);
  for (const cmd of bufferInputCommands) {
    lines.push(`    case ${cmd.commandId}:`);
    lines.push(
      `      w.push_u8(${cmd.commandId & 0xff}); w.push_u8(${(cmd.commandId >> 8) & 0xff});`,
    );
    lines.push(`      w.push_uvar(size);`);
    lines.push(`      if (size > 0) w.push_bytes(data, size);`);
    lines.push(`      return;`);
  }
  lines.push(
    `    default: throw std::invalid_argument("rustra: no buffer codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Value decode_buffer_result_by_id(Runtime& rt, uint16_t cmd_id, Value buffer) {`);
  lines.push(`  switch (cmd_id) {`);
  for (const { cmd, output } of bufferCommands) {
    lines.push(`    case ${cmd.commandId}: {`);
    lines.push(`      auto result = Object(rt);`);
    lines.push(
      `      result.setProperty(rt, cachedProp(rt, "${output.name}"), std::move(buffer));`,
    );
    lines.push(`      return result;`);
    lines.push(`    }`);
  }
  lines.push(
    `    default: throw JSError(rt, "rustra: no buffer result codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`bool has_raw_codec(uint16_t cmd_id) {`);
  lines.push(`  switch (cmd_id) {`);
  lines.push(rawCommands.map(({ cmd }) => `    case ${cmd.commandId}: return true;`).join('\n'));
  lines.push(`    default: return false;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `void encode_raw_slots(Runtime& rt, uint16_t cmd_id, const Value* argv, size_t argc, uint64_t* slots) {`,
  );
  lines.push(`  switch (cmd_id) {`);
  for (const { cmd, shape } of rawCommands) {
    lines.push(`    case ${cmd.commandId}: {`);
    lines.push(
      `      if (argc != ${shape.inputFields.length}) throw JSError(rt, "rustra: ${cmd.name} expects ${shape.inputFields.length} raw argument(s), got " + std::to_string(argc));`,
    );
    shape.inputFields.forEach((field, index) => {
      if (field.kind === 'zigzag') {
        lines.push(
          `      { int64_t value = rustra_i64(rt, argv[${index}], ${JSON.stringify(field.name)}); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
        );
      } else if (field.kind === 'uvar') {
        lines.push(
          `      slots[${index}] = rustra_u64(rt, argv[${index}], ${JSON.stringify(field.name)});`,
        );
      } else if (field.kind === 'f64') {
        lines.push(
          `      { double value = rustra_f64(rt, argv[${index}], ${JSON.stringify(field.name)}); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
        );
      } else if (field.kind === 'f32') {
        lines.push(
          `      { double value = static_cast<double>(rustra_f32(rt, argv[${index}], ${JSON.stringify(field.name)})); std::memcpy(&slots[${index}], &value, sizeof(value)); }`,
        );
      } else {
        lines.push(`      slots[${index}] = argv[${index}].getBool() ? 1u : 0u;`);
      }
    });
    lines.push(`      return;`);
    lines.push(`    }`);
  }
  lines.push(
    `    default: throw JSError(rt, "rustra: no raw input codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Value decode_raw_result(Runtime& rt, uint16_t cmd_id, uint64_t slot) {`);
  lines.push(`  switch (cmd_id) {`);
  for (const { cmd, shape } of rawCommands) {
    lines.push(`    case ${cmd.commandId}: {`);
    if (!shape.outputField) {
      lines.push(`      return Value::undefined();`);
    } else {
      const field = shape.outputField;
      lines.push(`      Object result(rt);`);
      if (field.kind === 'zigzag') {
        lines.push(`      int64_t value; std::memcpy(&value, &slot, sizeof(value));`);
        lines.push(
          `      result.setProperty(rt, cachedProp(rt, ${JSON.stringify(field.name)}), static_cast<double>(value));`,
        );
      } else if (field.kind === 'uvar') {
        lines.push(
          `      result.setProperty(rt, cachedProp(rt, ${JSON.stringify(field.name)}), static_cast<double>(slot));`,
        );
      } else if (field.kind === 'f64' || field.kind === 'f32') {
        lines.push(`      double value; std::memcpy(&value, &slot, sizeof(value));`);
        lines.push(
          `      result.setProperty(rt, cachedProp(rt, ${JSON.stringify(field.name)}), value);`,
        );
      } else {
        lines.push(
          `      result.setProperty(rt, cachedProp(rt, ${JSON.stringify(field.name)}), slot != 0);`,
        );
      }
      lines.push(`      return std::move(result);`);
    }
    lines.push(`    }`);
  }
  lines.push(
    `    default: throw JSError(rt, "rustra: no raw result codec for cmd_id " + std::to_string(cmd_id));`,
  );
  lines.push(`  }`);
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

  const typeImports = new Set<string>();
  for (const command of supported) {
    if (command.inputType !== '()') typeImports.add(command.inputType);
    if (command.outputType !== '()') typeImports.add(command.outputType);
  }
  const sortedTypeImports = [...typeImports].sort();

  if (sortedTypeImports.length > 0) {
    output += `import type { ${sortedTypeImports.join(', ')} } from './types.js';\n`;
  }
  output += `import type { InvokeOptions } from '@rustra/types';\n\n`;
  output +=
    `/** JSI 네이티브 모듈의 최소 인터페이스 — invokeTypedPos 노출 호스트 권장. */\n` +
    `export type PositionalNative = {\n` +
    `  invokeTyped(name: string, args: unknown): unknown;\n` +
    `  /** (P0-3) cmd_id 진입 — 문자열 마샬링을 건너뛴다. 미노출이면 이름 기반으로 폴백. */\n` +
    `  invokeTypedById?(cmdId: number, args: unknown): unknown;\n` +
    `  /** (Tier 1) positional 진입 — JS 인자 객체 생성/프로퍼티 조회를 통째로 건너뛴다. */\n` +
    `  invokeTypedPos?(cmdId: number, ...fields: unknown[]): unknown;\n` +
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
    `}\n\n` +
    `/** (Tier 1) positional 진입 — 개별 인자를 그대로 넘긴다(객체 생성 0). */\n` +
    `function callPos<T>(cmdId: number, ...fields: unknown[]): T {\n` +
    `  const native = requireNative();\n` +
    `  if (native.invokeTypedPos) {\n` +
    `    return native.invokeTypedPos(cmdId, ...fields) as T;\n` +
    `  }\n` +
    `  // 구 네이티브 폴백: 필드 순서는 스키마 프로퍼티 순(생성 시점 필드 리스트)과 동일.\n` +
    `  throw new Error(\n` +
    `    'positional entry unavailable — update the native module (invokeTypedPos)',\n` +
    `  );\n` +
    `}\n\n`;

  for (const command of supported) {
    const fnName = commandFunctionName(command.name);
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    const { fields } = collectPostcardFields(command.inputSchema, definitions);
    // 0..3개 필드 → positional; 4+ 또는 nested/option 조합은 객체 인자.
    // POSITIONAL_SCALAR_KINDS는 cppEncodePosCommand와 공유 — 한쪽만 바뀌면
    // facade의 callPos 명령에 C++ 코덱이 없어 런타임 JSError가 난다.
    const positionalKinds = new Set<string>(POSITIONAL_SCALAR_KINDS);
    const simple = fields.every((f) => positionalKinds.has(f.kind));
    const cmdId = command.commandId ?? 0;
    if (fields.length > 0 && fields.length <= 3 && simple) {
      // (Tier 1) 순수 스칼라 필드는 invokeTypedPos 로 — 인자 객체 생성 0.
      const params = fields
        .map((f) => `${f.name}: ${tsFieldType(f, command.inputType)}`)
        .join(', ');
      const argList = fields.map((f) => `${f.name}`).join(', ');
      output +=
        `export function ${fnName}(${params}, options?: InvokeOptions): Promise<${outType}> {\n` +
        `  void options;\n` +
        `  return Promise.resolve(callPos<${outType}>(${cmdId}, ${argList}));\n` +
        `}\n\n`;
    } else if (fields.length === 0) {
      output +=
        `export function ${fnName}(options?: InvokeOptions): Promise<${outType}> {\n` +
        `  void options;\n` +
        `  return Promise.resolve(call<${outType}>(${cmdId}, '${command.name}', undefined));\n` +
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
  return `${output.trimEnd()}\n`;
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
    case 'vec_i64':
    case 'vec_u64':
      return '(number | bigint)[]';
    case 'vec_bool':
      return 'boolean[]';
    case 'vec_string':
      return 'string[]';
    case 'set_zigzag':
      return 'Set<number>';
    case 'set_i64':
    case 'set_u64':
      return 'Set<number | bigint>';
    case 'set_f64':
      return 'Set<number>';
    case 'set_bool':
      return 'Set<boolean>';
    case 'set_uvar':
      return 'Set<number>';
    case 'uvar':
    case 'uvar64':
    case 'zigzag64':
      return 'number | bigint';
    case 'bytes':
      return 'Uint8Array | ArrayBuffer';
    case 'vec_uvar':
      return 'number[]';
    case 'map_zigzag':
    case 'map_uvar':
      return 'Record<string, number>';
    case 'map_i64':
    case 'map_u64':
      return 'Record<string, number | bigint>';
    case 'map_f64':
      return 'Record<string, number>';
    case 'map_bool':
      return 'Record<string, boolean>';
    case 'map_string':
      return 'Record<string, string>';
    case 'tuple': {
      const items = field.tupleItems ?? [];
      return `[${items.map((it) => tsFieldType(it, _ownerType)).join(', ')}]`;
    }
    case 'option_zigzag':
    case 'option_uvar':
    case 'option_f64':
    case 'option_f32':
      return 'number | null';
    case 'option_zigzag64':
    case 'option_uvar64':
      return 'number | bigint | null';
    case 'option_bool':
      return 'boolean | null';
    case 'option_string':
      return 'string | null';
    case 'option_struct': {
      const inner: PostcardField = { ...field, kind: 'struct' };
      return `${tsFieldType(inner, _ownerType)} | null`;
    }
    case 'option_bytes':
      return 'Uint8Array | null';
    default:
      return 'unknown';
  }
}
