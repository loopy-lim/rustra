import type { DoctorReport } from './doctor-types.js';

export const formatDoctorJson = (report: DoctorReport): string => JSON.stringify(report, null, 2);
export function formatDoctorText(report: DoctorReport): string {
  return report.checks
    .map((item) => {
      const lines = [`${item.status.toUpperCase()} ${item.id} ${item.summary}`];
      if (item.detail) lines.push(`  detail: ${item.detail}`);
      for (const fix of item.fix ?? []) lines.push(`  fix: ${fix}`);
      return lines.join('\n');
    })
    .join('\n');
}
