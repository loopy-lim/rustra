/**
 * codegen/diff 의 `--format json` 표면 — doctor 의 formatDoctorJson 패턴 준거.
 *
 * CI 통합 표면 통일이 목적이다: doctor 는 `{ schemaVersion: 1, ... }` 로 기계가
 * 읽는 보고를 이미 운반하고, codegen/diff 는 텍스트(또는 구형 임의 JSON)만
 * 내보냈다. 세 커맨드가 같은 schemaVersion: 1 관례를 공유하면 자동화 작성자는
 * 한 가지 파싱 관례만 알면 된다.
 *
 * - codegen → `{ schemaVersion: 1, written, drift, durationMs }`
 * - explain → `{ schemaVersion: 1, explain: rows }` (`codegen --explain --format json`)
 * - diff    → `{ schemaVersion: 1, breaking, clean }` (exit 코드는 불변 —
 *   breaking 이면 1. clean 필드는 파싱 없이도 판정을 복창하는 중복 표기다)
 *
 * diff 의 breaking 배열은 DiffResult.breaking 을 **그대로** 실린다 — Task 3의
 * 이벤트 게이트(event_removed / event_payload_changed fold)가 만든 구조가
 * 변형 없이 JSON 에 도달해야 소비자가 텍스트 렌더러와 같은 판별을 본다.
 * diagnoses 는 텍스트 렌더러(formatDiffResult) 전용으로 한다 — JSON 은
 * 스키마 수준 판정만 운반한다.
 */
import type { DiffResult } from './schema-diff.js';
import type { ExplainRow } from './codegen-explain.js';

/** `codegen --explain --format json` 보고 — 표면 지도 행을 그대로 실린다. */
export interface ExplainJsonReport {
  explain: ExplainRow[];
}

/**
 * `codegen --explain` 의 JSON 표면 — doctor/diff 와 같은 schemaVersion:1 관례.
 * 구형 `{command:'codegen', explain}` 임의 shape 는 소비자 0건을 확인하고 통일했다.
 */
export const formatExplainJson = (report: ExplainJsonReport): string =>
  JSON.stringify({ schemaVersion: 1 as const, ...report }, null, 2);

/**
 * `codegen --format json` 보고 입력 — written 은 runGenerate 의 진행 표기
 * 문자열(`(updated)`/`(unchanged)` 접미어, 신규 파일은 순수 경로).
 */
export interface CodegenJsonReport {
  written: string[];
  /**
   * write 모드에서 재생성이 기존 파일을 고쳤을 때 true. check 모드는 불일치 시
   * throw 하므로 JSON 에 도달하지 않는다(도달 시 항상 false) — 실제 드리프트
   * 관측은 doctor 의 codegen.generated_freshness 검사가 담당한다.
   */
  drift: boolean;
  durationMs: number;
}

/** schemaVersion 은 포매터가 단일 지점에서 주입한다 — 호출자가 잊을 수 없다. */
export const formatCodegenJson = (report: CodegenJsonReport): string =>
  JSON.stringify({ schemaVersion: 1 as const, ...report }, null, 2);

export const formatDiffJson = (result: DiffResult): string =>
  JSON.stringify(
    { schemaVersion: 1, breaking: result.breaking, clean: result.breaking.length === 0 },
    null,
    2,
  );
