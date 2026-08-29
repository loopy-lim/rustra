import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultDoctorRunner,
  type DoctorOptions,
  type DoctorReport,
  type DoctorRunner,
} from './doctor-types.js';
import { check, memoizeRunner, readConfig } from './doctor-support.js';
import { collectBaseChecks, collectConfigChecks } from './doctor-checks.js';

export function collectDoctorReport(
  options: DoctorOptions,
  runner: DoctorRunner = defaultDoctorRunner,
): DoctorReport {
  const configPath = resolve(options.configPath);
  const cached = memoizeRunner(runner);
  const checks = collectBaseChecks(options, cached);
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
  checks.push(...collectConfigChecks(options, cached, configPath, parsed.config));
  return { schemaVersion: 1, checks };
}
