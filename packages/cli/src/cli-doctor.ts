import { resolve } from 'node:path';
import {
  collectDoctorReportAsync,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorText,
  parseDoctorArgs,
} from './doctor.js';

export async function runDoctor(args: string[]): Promise<void> {
  const options = parseDoctorArgs(args);
  const report = await collectDoctorReportAsync({
    configPath: resolve(options.configPath),
    strict: options.strict,
  });
  console.log(options.format === 'json' ? formatDoctorJson(report) : formatDoctorText(report));
  process.exitCode = doctorExitCode(report, options.strict);
}
