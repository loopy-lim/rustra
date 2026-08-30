import type { DoctorMatrix, DoctorReport } from './doctor-types.js';

export const formatDoctorJson = (report: DoctorReport): string => JSON.stringify(report, null, 2);

/** 매트릭스 표 — 헤더 폭은 가장 긴 target 길이에 맞춘다(정렬 유지). */
export function formatDoctorMatrix(matrix: DoctorMatrix): string {
  const width = Math.max(
    'target'.length,
    ...matrix.rows.map((row) => row.target.length),
    'reactNative'.length,
  );
  const columns: Array<keyof Omit<DoctorMatrix['rows'][number], 'target' | 'notes'>> = [
    'build',
    'contract',
    'runtime',
  ];
  const CELL_WIDTH = 11;
  const pad = (value: string) => value.padEnd(width);
  const lines = [
    `${pad('target')}  ${columns
      .map((name, index) => name.padEnd(index === columns.length - 1 ? 0 : CELL_WIDTH))
      .join('')}  notes`,
    ...matrix.rows.map((row) => {
      const cells = columns
        .map((name, index) => row[name].padEnd(index === columns.length - 1 ? 0 : CELL_WIDTH))
        .join('');
      return `${pad(row.target)}  ${cells}  ${row.notes}`;
    }),
  ];
  if (matrix.warnings.length > 0)
    lines.push('', ...matrix.warnings.map((warning) => `! ${warning}`));
  return lines.join('\n');
}

export function formatDoctorText(report: DoctorReport): string {
  const checks = report.checks
    .map((item) => {
      const lines = [`${item.status.toUpperCase()} ${item.id} ${item.summary}`];
      if (item.detail) lines.push(`  detail: ${item.detail}`);
      for (const fix of item.fix ?? []) lines.push(`  fix: ${fix}`);
      return lines.join('\n');
    })
    .join('\n');
  // 매트릭스는 checks 뒤에 붙는 집계 뷰다 — checks 라인 형식은 그대로 유지한다.
  return report.matrix ? `${checks}\n\n${formatDoctorMatrix(report.matrix)}` : checks;
}
