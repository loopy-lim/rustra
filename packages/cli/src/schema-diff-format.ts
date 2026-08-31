import type { DiffResult } from './schema-diff.js';

export function formatDiffResult(result: DiffResult): string {
  const lines: string[] = [];
  if (result.breaking.length === 0) lines.push('No breaking changes detected.');
  else {
    lines.push(`Breaking changes (${result.breaking.length}):`);
    for (const change of result.breaking) {
      switch (change.type) {
        case 'command_removed':
          lines.push(`  - Command removed: ${change.command}`);
          break;
        case 'field_removed':
          lines.push(`  - Field removed: ${change.command}.${change.field}`);
          break;
        case 'field_type_changed':
          lines.push(
            `  - Type changed: ${change.command}.${change.field} (${change.from} → ${change.to})`,
          );
          break;
        case 'required_field_added':
          lines.push(`  - Required field added: ${change.command}.${change.field}`);
          break;
        case 'field_became_required':
          lines.push(`  - Existing field became required: ${change.command}.${change.field}`);
          break;
        case 'field_became_optional':
          lines.push(`  - Existing field became optional: ${change.command}.${change.field}`);
          break;
        case 'definition_removed':
          lines.push(`  - Definition removed: ${change.command}.${change.field}`);
          break;
        case 'command_id_changed':
          lines.push(`  - Command id changed: ${change.command} (${change.from} → ${change.to})`);
          break;
        default: {
          // 컴파일 타임 완전성 검사 — 새 BreakingChange 변형 추가 시 여기서 에러.
          const _exhaustive: never = change;
          throw new Error(`unhandled breaking change type: ${String(_exhaustive)}`);
        }
      }
    }
  }
  if (result.compatible.length > 0) {
    lines.push(`Compatible changes (${result.compatible.length}):`);
    for (const note of result.compatible) lines.push(`  + ${note}`);
  }
  // (B4) 원인 진단 — 기존 "Header (n):" 관례에 맞춰 그룹 헤더로 묶는다.
  if ((result.diagnoses?.length ?? 0) > 0) {
    lines.push(`Diagnoses (${result.diagnoses.length}):`);
    for (const diagnosis of result.diagnoses) lines.push(`  ! ${diagnosis.detail}`);
  }
  return lines.join('\n');
}
