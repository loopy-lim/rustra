import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultDoctorRunner,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
  type DoctorRunner,
} from './doctor-types.js';
import { check, memoizeRunner, readConfig } from './doctor-support.js';
import { collectBaseChecks, collectConfigChecks } from './doctor-checks.js';
import { buildMatrix, collectSectionChecks } from './doctor-matrix.js';

export function collectDoctorReport(
  options: DoctorOptions,
  runner: DoctorRunner = defaultDoctorRunner,
  /** collectDoctorReportAsync 가 미리 당겨 온 registry.reachability 결과 — 없으면 skip. */
  registry?: DoctorCheck,
): DoctorReport {
  const configPath = resolve(options.configPath);
  const cached = memoizeRunner(runner);
  // 동기 경로는 fetch 프리브를 못 돌린다 — skip 행으로 명시한다(누락이 아님).
  const checks = collectBaseChecks(options, cached, registry);
  if (!existsSync(configPath)) {
    checks.unshift(
      check('config.file', 'fail', true, `Config file does not exist: ${configPath}`, undefined, [
        'Create rustra.json or pass --config <path>',
      ]),
    );
    return { schemaVersion: 1, checks };
  }
  const parsed = readConfig(configPath);
  if (!parsed.config) {
    checks.unshift(check('config.file', 'fail', true, 'Config file is invalid JSON', parsed.error));
    return { schemaVersion: 1, checks };
  }
  checks.unshift(check('config.file', 'pass', true, `Config file is readable: ${configPath}`));
  // 섹션 검사(빌드/교차 일관성)는 기존 codegen/RN/tauri 검사보다 먼저 수집한다.
  // 한 섹션이 red 여도 다른 섹션 검사는 계속 수행된다(루프가 예외를 던지지 않는다).
  checks.push(...collectSectionChecks(cached, configPath, parsed.config));
  checks.push(...collectConfigChecks(options, cached, configPath, parsed.config));
  // 매트릭스는 checks 의 파생 뷰 — 호스트 섹션이 2개 이상일 때만 필드 자체를 만든다.
  const matrix = buildMatrix(checks, parsed.config);
  return matrix ? { schemaVersion: 1, checks, matrix } : { schemaVersion: 1, checks };
}
