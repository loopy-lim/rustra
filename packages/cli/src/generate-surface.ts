/**
 * @rustra/cli — TypeScript 코드 생성기
 *
 * rustra 패키지 스키마에서 TypeScript 타입 정의, 명령 헬퍼 함수,
 * 계약 해시 파일을 생성합니다.
 */

import type { CommandSchema, PackageSchema } from './schema.js';
import {
  collectDefinitions,
  escapeJsDoc,
  postcardHelperSource,
  tsTypeFromSchema,
} from './codegen.js';
import { buildCodecIr } from './codec-ir.js';
import type { CodecIrNode } from './codec-ir.js';
import { sha256 } from './hash.js';

export function generatedJsDoc(description: string): string {
  const body = escapeJsDoc(description)
    .split('\n')
    .map((line) => (line.length > 0 ? ` * ${line}` : ' *'))
    .join('\n');
  return `/**\n${body}\n */\n`;
}

export function finishGeneratedText(output: string): string {
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

export function generateContractTs(schemaJson: string): string {
  const hash = sha256(schemaJson);
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
// (8) C++ 게이트(cppComplexNativeSupported), (9) 64-bit 헬퍼
// 코드젠(codegen.ts postcardHelperSource) + 와이어 픽스처 양면.
