import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  defaultDoctorRunnerAsync,
  type DoctorAsyncRunner,
  type DoctorCommandResult,
  type DoctorOptions,
  type DoctorReport,
  type DoctorRunner,
} from './doctor-types.js';
import { readConfig, resolveManifest } from './doctor-support.js';
import { collectDoctorReport } from './doctor-report.js';

const key = (command: string, args: string[]) => JSON.stringify([command, args]);

export async function collectDoctorReportAsync(
  options: DoctorOptions,
  runner: DoctorAsyncRunner = defaultDoctorRunnerAsync,
): Promise<DoctorReport> {
  const probes = new Map<string, [string, string[]]>();
  const add = (command: string, args: string[]) => probes.set(key(command, args), [command, args]);
  add('rustc', ['--version']);
  add('cargo', ['--version']);
  add('node', ['--version']);
  add('bun', ['--version']);
  const platform = options.platform ?? process.platform;
  add(platform === 'win32' ? 'cl' : 'c++', platform === 'win32' ? ['/Bv'] : ['--version']);
  add('cmake', ['--version']);
  const configPath = resolve(options.configPath);
  if (existsSync(configPath)) {
    const parsed = readConfig(configPath);
    if (parsed.config) {
      const manifest = resolveManifest(dirname(configPath), parsed.config);
      if (manifest)
        add('cargo', [
          'metadata',
          '--format-version',
          '1',
          '--no-deps',
          '--manifest-path',
          manifest,
        ]);
      if (parsed.config.reactNative) {
        if (platform === 'darwin') {
          add('xcodebuild', ['-version']);
          add('pod', ['--version']);
        }
        add('java', ['-version']);
        add('adb', ['version']);
        add('sdkmanager', ['--version']);
        add('rustup', ['target', 'list', '--installed']);
      }
      if (parsed.config.tauri) {
        const command =
          platform === 'darwin' ? 'xcodebuild' : platform === 'win32' ? 'cl' : 'pkg-config';
        add(
          command,
          command === 'xcodebuild' ? ['-version'] : command === 'pkg-config' ? ['--version'] : [],
        );
      }
    }
  }
  const results = new Map<string, DoctorCommandResult>();
  await Promise.all(
    [...probes.entries()].map(async ([probe, [command, args]]) =>
      results.set(probe, await runner(command, args)),
    ),
  );
  const cachedRunner: DoctorRunner = (command, args) =>
    results.get(key(command, args)) ?? {
      ok: false,
      stdout: '',
      stderr: `probe was not prefetched: ${command} ${args.join(' ')}`,
    };
  return collectDoctorReport(options, cachedRunner);
}
