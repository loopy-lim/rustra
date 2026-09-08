import type { PackageSchema } from './schema.js';
import type { BreakingChange, ContractDiagnosis } from './schema-diff.js';

/**
 * compareSchemas 가 내보낼 수 있는 스키마 수준 진단 6종 — 명령/이벤트 공통.
 */
export type SchemaLevelFinding = Extract<
  BreakingChange,
  {
    type:
      | 'field_removed'
      | 'field_type_changed'
      | 'required_field_added'
      | 'field_became_required'
      | 'field_became_optional'
      | 'definition_removed';
  }
>;

/**
 * compareSchemas 가 내보낸 일반 필드 진단을 이벤트 계약 변형으로 접는다.
 * 명령 필드와 달리 이벤트 페이로드는 command 컨텍스트가 없으므로 path/before/after
 * 로 재표현해 event_payload_changed 하나의 보고 형태로 통일한다.
 */
export function foldPayloadFinding(event: string, finding: SchemaLevelFinding): BreakingChange {
  switch (finding.type) {
    case 'field_type_changed':
      // 타입 변경의 command 는 이미 전체 노드 경로다 (부모+필드 결합 금지).
      return {
        type: 'event_payload_changed',
        event,
        path: finding.command,
        before: finding.from,
        after: finding.to,
      };
    case 'field_removed':
      return {
        type: 'event_payload_changed',
        event,
        path: `${finding.command}.${finding.field}`,
        before: '(present)',
        after: '(removed)',
      };
    case 'required_field_added':
      // 구 페이로드에 필드가 없었다 — optional 이었던 게 아니다 (명령 쪽
      // Required field added vs Existing field became required 구분과 정합).
      return {
        type: 'event_payload_changed',
        event,
        path: `${finding.command}.${finding.field}`,
        before: '(absent)',
        after: '(required)',
      };
    case 'field_became_required':
      return {
        type: 'event_payload_changed',
        event,
        path: `${finding.command}.${finding.field}`,
        before: '(optional)',
        after: '(required)',
      };
    case 'field_became_optional':
      return {
        type: 'event_payload_changed',
        event,
        path: `${finding.command}.${finding.field}`,
        before: '(required)',
        after: '(optional)',
      };
    case 'definition_removed':
      return {
        type: 'event_payload_changed',
        event,
        path: `${finding.command}.${finding.field}`,
        before: '(definition)',
        after: '(removed)',
      };
    default: {
      // 런타임 방어 — payloadFindings 배열의 공변성으로 컴파일 타임 완전성이
      // 무력화될 수 있어 formatDiffResult 의 never+throw 관례와 정합하게 둔다.
      const _exhaustive: never = finding;
      throw new Error(`unhandled payload finding type: ${String(_exhaustive)}`);
    }
  }
}
/**
 * (B4) command_id 축의 불일치 진단. 기존 필드 비교는 스키마 JSON 만 보므로
 * wire 디스패치의 핵심인 command_id 변화가 보이지 않는다 — 같은 스키마 모양이라도
 * id 가 밀리면 byId 호출이 전부 갈라진다. 새 breaking 항목(command_id_changed)과
 * 원인 문장 진단을 함께 만든다.
 *
 * parsePackageSchema 는 commandId 를 검증하지 않으므로 id 없는(또는 한쪽만 있는)
 * 스키마가 CLI 에 그대로 들어올 수 있다 — id 가 양쪽 다 숫자가 아니면 비교 자체가
 * 무의미하므로 (undefined → undefined 는 동일, 한쪽만 있으면 비교 불가) 조용히
 * 건너뛴다. 'undefined' 문자열이 텍스트/JSON 에 새는 것을 막는 가드다.
 */
export function diagnoseContractGaps(
  newSchema: PackageSchema,
  oldCommands: Map<string, PackageSchema['commands'][number]>,
  newCommands: Map<string, PackageSchema['commands'][number]>,
  diagnoses: ContractDiagnosis[],
  breaking: BreakingChange[],
): void {
  for (const [name, oldCmd] of oldCommands) {
    const newCmd = newCommands.get(name);
    if (!newCmd) continue; // command_removed 는 위에서 이미 처리했다.
    if (oldCmd.commandId === newCmd.commandId) continue;
    if (typeof oldCmd.commandId !== 'number' || typeof newCmd.commandId !== 'number') continue;
    breaking.push({
      type: 'command_id_changed',
      command: name,
      from: oldCmd.commandId,
      to: newCmd.commandId,
    });
    diagnoses.push({
      code: 'command_id_displaced',
      command: name,
      oldId: oldCmd.commandId,
      newId: newCmd.commandId,
      detail:
        `command '${name}' kept its name but its command id changed from ` +
        `${oldCmd.commandId} to ${newCmd.commandId}: old clients dispatching by ` +
        `the old id will no longer reach '${name}'`,
    });
  }

  // (OTA) 구 id 가 다른 명령의 실제 id 로 점유됐는지 검사한다 — 네이티브에
  // alias_command_id 선언이 빠졌을 때 정확히 이 모양이 된다 (builder_build.rs 의
  // 점유 해소가 없으면 구 id 호출이 새 명령으로 라우팅된다).
  const newIdToName = new Map<number, string>();
  for (const command of newSchema.commands) {
    if (typeof command.commandId === 'number') newIdToName.set(command.commandId, command.name);
  }
  for (const [name, oldCmd] of oldCommands) {
    const newCmd = newCommands.get(name);
    if (!newCmd || oldCmd.commandId === newCmd.commandId) continue;
    if (typeof oldCmd.commandId !== 'number') continue;
    const occupant = newIdToName.get(oldCmd.commandId);
    if (occupant === undefined || occupant === name) continue;
    diagnoses.push({
      code: 'alias_missing',
      command: name,
      legacyId: oldCmd.commandId,
      occupiedBy: occupant,
      detail:
        `legacy command id ${oldCmd.commandId} (used by '${name}' in the old schema) ` +
        `now dispatches '${occupant}': declare alias_command_id("${name}", ` +
        `${oldCmd.commandId}) on the native side to keep old clients routed`,
    });
  }
}
