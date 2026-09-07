import type { PackageSchema } from './schema.js';
import {
  diagnoseContractGaps,
  foldPayloadFinding,
  type SchemaLevelFinding,
} from './schema-diff-diagnose.js';
import { compareSchemas } from './schema-diff-traverse.js';
export { formatDiffResult } from './schema-diff-format.js';
export type BreakingChange =
  | { type: 'field_removed'; command: string; field: string }
  | { type: 'field_type_changed'; command: string; field: string; from: string; to: string }
  | { type: 'required_field_added'; command: string; field: string }
  | { type: 'field_became_required'; command: string; field: string }
  | { type: 'field_became_optional'; command: string; field: string }
  | { type: 'definition_removed'; command: string; field: string }
  | { type: 'command_removed'; command: string }
  | { type: 'command_id_changed'; command: string; from: number; to: number }
  | { type: 'event_removed'; event: string }
  | {
      type: 'event_payload_changed';
      event: string;
      path: string;
      before: string;
      after: string;
    };

/**
 * (B4) breaking change 의 "왜 와이어가 깨지는가" 를 지목하는 진단.
 * `DiffResult.diagnoses` 로 운반되며, OTA onContractMismatch 콜백의
 * `diagnosis` 필드로도 전달될 수 있다.
 */
export type ContractDiagnosis =
  | {
      /** 동일 이름 명령의 command_id 가 바뀜 — byId 호출자가 엉뚱한 명령에 도달한다. */
      code: 'command_id_displaced';
      command: string;
      oldId: number;
      newId: number;
      /** 사람이 읽는 원인 문장 (포맷터가 그대로 출력한다). */
      detail: string;
    }
  | {
      /** 구 command_id 를 다른 명령이 점유 — 네이티브에 alias 선언이 없어 라우팅이 갈린다. */
      code: 'alias_missing';
      command: string;
      legacyId: number;
      /** 구 id 를 이제 가리키는 명령 이름. */
      occupiedBy: string;
      detail: string;
    }
  | {
      /** 필드 타입 변경이 postcard 위치 인코딩을 바꿈 — 구 페이로드 디코딩이 실패한다. */
      code: 'wire_type_changed';
      command: string;
      field: string;
      from: string;
      to: string;
      detail: string;
    };

export interface DiffResult {
  breaking: BreakingChange[];
  compatible: string[];
  /**
   * (B4) 원인 진단 목록. 진단이 없으면 빈 배열 — 구 소비자(structuredClone/
   * JSON 직렬화 등)를 깨뜨리지 않도록 항상 채운다.
   */
  diagnoses: ContractDiagnosis[];
}

export function diffSchemas(oldSchema: PackageSchema, newSchema: PackageSchema): DiffResult {
  const breaking: BreakingChange[] = [];
  const compatible: string[] = [];
  const diagnoses: ContractDiagnosis[] = [];

  const oldCommands = new Map(oldSchema.commands.map((c) => [c.name, c]));
  const newCommands = new Map(newSchema.commands.map((c) => [c.name, c]));

  for (const [name, oldCmd] of oldCommands) {
    if (!newCommands.has(name)) {
      breaking.push({ type: 'command_removed', command: name });
      continue;
    }

    const newCmd = newCommands.get(name)!;
    compareSchemas(
      oldCmd.inputSchema,
      newCmd.inputSchema,
      `${name}.input`,
      breaking,
      compatible,
      oldCmd.definitions,
      newCmd.definitions,
    );
    compareSchemas(
      oldCmd.outputSchema,
      newCmd.outputSchema,
      `${name}.output`,
      breaking,
      compatible,
      oldCmd.definitions,
      newCmd.definitions,
    );
  }

  const oldEvents = new Map((oldSchema.events ?? []).map((e) => [e.name, e]));
  const newEvents = new Map((newSchema.events ?? []).map((e) => [e.name, e]));

  for (const [name, oldEvent] of oldEvents) {
    const newEvent = newEvents.get(name);
    if (!newEvent) {
      // 이벤트 이름의 존재 자체가 계약이다 — 제거되면 구독 코드가 깨진다.
      breaking.push({ type: 'event_removed', event: name });
      continue;
    }
    // 페이로드 비교는 명령 입력/출력과 같은 compareSchemas 를 재사용하되 결과를
    // event_payload_changed 로 접어 이벤트 계약의 보고 경로를 통일한다.
    const payloadFindings: SchemaLevelFinding[] = [];
    compareSchemas(
      oldEvent.payload,
      newEvent.payload,
      `events.${name}.payload`,
      payloadFindings,
      compatible,
      oldEvent.definitions,
      newEvent.definitions,
    );
    for (const finding of payloadFindings) breaking.push(foldPayloadFinding(name, finding));
  }

  // 이벤트 추가는 구독자를 깨지 않는다(non-breaking) — compatible 로만 보고한다.
  for (const name of newEvents.keys()) {
    if (!oldEvents.has(name)) compatible.push(`event '${name}' added`);
  }

  diagnoseContractGaps(newSchema, oldCommands, newCommands, diagnoses, breaking);

  // 타입 변경 진단: postcard 는 위치 기반 비-자기서술 인코딩이므로 필드 타입이
  // 바뀌면 와이어 모양 자체가 바뀐다 (넓히기 호환 개념이 없다 — i64 와 f64 조차
  // 바이트 배치가 다르다). field_type_changed 마다 원인 문장을 붙인다.
  for (const change of breaking) {
    if (change.type !== 'field_type_changed') continue;
    diagnoses.push({
      code: 'wire_type_changed',
      command: change.command,
      field: change.field,
      from: change.from,
      to: change.to,
      detail:
        `field '${change.command}' changed from ${change.from} to ${change.to}: ` +
        `the postcard wire encoding changes shape, so old payloads no longer ` +
        `decode against the new schema`,
    });
  }

  return { breaking, compatible, diagnoses };
}
