import { execFile, spawnSync } from 'node:child_process';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';

export const RUSTRA_MSRV: [number, number, number] = [1, 88, 0];
export const ANDROID_NDK_VERSION = '27.1.12297006';
export const DEFAULT_ANDROID_TARGETS = ['aarch64-linux-android', 'x86_64-linux-android'];

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  required: boolean;
  summary: string;
  detail?: string;
  fix?: string[];
}
export interface DoctorReport {
  schemaVersion: 1;
  checks: DoctorCheck[];
}
export interface DoctorOptions {
  configPath: string;
  strict: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}
export interface DoctorCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}
export type DoctorRunner = (command: string, args: string[]) => DoctorCommandResult;
export type DoctorAsyncRunner = (command: string, args: string[]) => Promise<DoctorCommandResult>;
export interface DoctorCliOptions {
  configPath: string;
  format: 'text' | 'json';
  strict: boolean;
}
export interface DoctorConfig {
  schema?: string;
  output?: string;
  cppOutput?: string;
  codegen?: { rustManifest?: string; rustPackage?: string; rustBinary?: string };
  reactNative?: Record<string, unknown>;
  node?: Record<string, unknown>;
  bun?: Record<string, unknown>;
  tauri?: Record<string, unknown>;
}
export interface CargoMetadata {
  packages?: Array<{
    name?: string;
    manifest_path?: string;
    targets?: Array<{ name?: string; kind?: string[]; crate_types?: string[] }>;
  }>;
}

export function parseDoctorArgs(args: string[]): DoctorCliOptions {
  const parsed = parseCliArgs(args, {
    command: 'doctor',
    valueFlags: ['config', 'format'],
    booleanFlags: ['strict', 'help', 'h'],
  });
  const configPath = parsed.values.get('config') ?? 'rustra.json';
  if (!configPath) throw new Error('doctor --config requires a path');
  return {
    configPath,
    format: cliFormat(parsed.values.get('format'), 'doctor') ?? 'text',
    strict: parsed.flags.has('strict'),
  };
}

export function parseRustVersion(value: string): [number, number, number] | null {
  const match = /rustc\s+(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function isVersionAtLeast(
  candidate: [number, number, number],
  minimum: [number, number, number],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (candidate[index] !== minimum[index]) return candidate[index] > minimum[index];
  }
  return true;
}
export function doctorExitCode(report: DoctorReport, strict: boolean): number {
  return report.checks.some(
    (check) => (check.status === 'fail' && check.required) || (strict && check.status === 'warn'),
  )
    ? 1
    : 0;
}
export function defaultDoctorRunner(command: string, args: string[]): DoctorCommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}
export function defaultDoctorRunnerAsync(
  command: string,
  args: string[],
): Promise<DoctorCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error?.message,
      });
    });
  });
}
