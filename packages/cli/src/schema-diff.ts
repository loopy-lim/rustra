import type { PackageSchema } from './schema.js';
import {
  asRecord,
  isString,
  lastSegment,
  objectId,
  resolveDefinition,
  schemaShape,
} from './schema-diff-helpers.js';
export { formatDiffResult } from './schema-diff-format.js';
export type BreakingChange =
  | { type: 'field_removed'; command: string; field: string }
  | { type: 'field_type_changed'; command: string; field: string; from: string; to: string }
  | { type: 'required_field_added'; command: string; field: string }
  | { type: 'field_became_required'; command: string; field: string }
  | { type: 'field_became_optional'; command: string; field: string }
  | { type: 'definition_removed'; command: string; field: string }
  | { type: 'command_removed'; command: string }
  | { type: 'command_id_changed'; command: string; from: number; to: number };

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

  diagnoseContractGaps(oldSchema, newSchema, oldCommands, newCommands, diagnoses, breaking);

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

/**
 * (B4) command_id 축의 불일치 진단. 기존 필드 비교는 스키마 JSON 만 보므로
 * wire 디스패치의 핵심인 command_id 변화가 보이지 않는다 — 같은 스키마 모양이라도
 * id 가 밀리면 byId 호출이 전부 갈라진다. 새 breaking 항목(command_id_changed)과
 * 원인 문장 진단을 함께 만든다.
 */
function diagnoseContractGaps(
  oldSchema: PackageSchema,
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
  const newIdToName = new Map(newSchema.commands.map((c) => [c.commandId, c.name]));
  for (const [name, oldCmd] of oldCommands) {
    const newCmd = newCommands.get(name);
    if (!newCmd || oldCmd.commandId === newCmd.commandId) continue;
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
function compareSchemas(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  oldDefinitions: Record<string, unknown> | undefined = undefined,
  newDefinitions: Record<string, unknown> | undefined = undefined,
): void {
  const visited = new Set<string>();
  compareSchemaNodes(oldSchema, newSchema, path, breaking, compatible, visited, {
    old: { ...asRecord((oldSchema as Record<string, unknown>)?.definitions), ...oldDefinitions },
    new: { ...asRecord((newSchema as Record<string, unknown>)?.definitions), ...newDefinitions },
  });
}
type DefinitionContext = {
  old: Record<string, unknown>;
  new: Record<string, unknown>;
};
function compareSchemaNodes(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  visited: Set<string>,
  definitions: DefinitionContext,
): void {
  if (typeof oldSchema !== 'object' || typeof newSchema !== 'object') return;
  if (!oldSchema || !newSchema) return;
  const oldObj = oldSchema as Record<string, unknown>;
  const newObj = newSchema as Record<string, unknown>;
  const oldRef = typeof oldObj.$ref === 'string' ? oldObj.$ref : undefined;
  const newRef = typeof newObj.$ref === 'string' ? newObj.$ref : undefined;
  if (oldRef || newRef) {
    if (oldRef !== newRef) {
      breaking.push({
        type: 'field_type_changed',
        command: path,
        field: lastSegment(path),
        from: oldRef ?? schemaShape(oldObj),
        to: newRef ?? schemaShape(newObj),
      });
      return;
    }
    const oldResolved = oldRef ? resolveDefinition(oldRef, definitions.old) : oldSchema;
    const newResolved = newRef ? resolveDefinition(newRef, definitions.new) : newSchema;
    if (oldResolved && newResolved && (oldResolved !== oldSchema || newResolved !== newSchema)) {
      compareSchemaNodes(
        oldResolved,
        newResolved,
        path,
        breaking,
        compatible,
        visited,
        definitions,
      );
      return;
    }
  }
  const pairKey = `${objectId(oldSchema)}:${objectId(newSchema)}:${path}`;
  if (visited.has(pairKey)) return;
  visited.add(pairKey);

  const oldShape = schemaShape(oldObj);
  const newShape = schemaShape(newObj);
  if (oldShape !== newShape) {
    breaking.push({
      type: 'field_type_changed',
      command: path,
      field: lastSegment(path),
      from: oldShape,
      to: newShape,
    });
    return;
  }

  const oldProps = asRecord(oldObj.properties);
  const newProps = asRecord(newObj.properties);
  const oldRequired = new Set(
    Array.isArray(oldObj.required) ? oldObj.required.filter(isString) : [],
  );
  const newRequired = new Set(
    Array.isArray(newObj.required) ? newObj.required.filter(isString) : [],
  );

  for (const field of Object.keys(oldProps)) {
    if (!(field in newProps)) {
      breaking.push({ type: 'field_removed', command: path, field });
      continue;
    }
    if (!oldRequired.has(field) && newRequired.has(field)) {
      breaking.push({ type: 'field_became_required', command: path, field });
    } else if (oldRequired.has(field) && !newRequired.has(field)) {
      breaking.push({ type: 'field_became_optional', command: path, field });
    }
    compareSchemaNodes(
      oldProps[field],
      newProps[field],
      `${path}.${field}`,
      breaking,
      compatible,
      visited,
      definitions,
    );
  }

  for (const field of Object.keys(newProps)) {
    if (field in oldProps) continue;
    if (newRequired.has(field)) {
      breaking.push({ type: 'required_field_added', command: path, field });
    } else {
      compatible.push(`${path}: optional field '${field}' added`);
    }
  }

  compareSchemaArray(
    oldObj.items,
    newObj.items,
    `${path}[]`,
    breaking,
    compatible,
    visited,
    definitions,
  );
  const oldNestedDefinitions = asRecord(oldObj.definitions ?? oldObj.$defs);
  const newNestedDefinitions = asRecord(newObj.definitions ?? newObj.$defs);
  for (const name of Object.keys(oldNestedDefinitions)) {
    if (!(name in newNestedDefinitions)) {
      breaking.push({ type: 'definition_removed', command: path, field: name });
    } else {
      compareSchemaNodes(
        oldNestedDefinitions[name],
        newNestedDefinitions[name],
        `${path}.definitions.${name}`,
        breaking,
        compatible,
        visited,
        definitions,
      );
    }
  }
}
function compareSchemaArray(
  oldSchema: unknown,
  newSchema: unknown,
  path: string,
  breaking: BreakingChange[],
  compatible: string[],
  visited: Set<string>,
  definitions: DefinitionContext,
): void {
  if (oldSchema === undefined || newSchema === undefined) return;
  compareSchemaNodes(oldSchema, newSchema, path, breaking, compatible, visited, definitions);
}
