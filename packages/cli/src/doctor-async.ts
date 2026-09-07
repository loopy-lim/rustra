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
import { probeRegistryReachability, readConfig, resolveManifest } from './doctor-support.js';
import { doctorHostSections, resolveSectionManifest } from './doctor-matrix.js';
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
      const configRoot = dirname(configPath);
      const manifests = new Set<string>();
      const codegenManifest = resolveManifest(configRoot, parsed.config);
      if (codegenManifest) manifests.add(codegenManifest);
      // 섹션 루프가 쓰는 매니페스트를 전부 미리 당겨 온다(한 섹션 red 무관 전부 수집).
      for (const target of doctorHostSections(parsed.config)) {
        const sectionManifest = resolveSectionManifest(configRoot, parsed.config, target);
        if (sectionManifest) manifests.add(sectionManifest);
      }
      for (const manifest of manifests)
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
  // registry 도달성은 명령 프리브가 아니라 fetch 다 — runner 시임 밖에서 같은
  // Promise.all 로 병렬 당겨 온다(3초 타임아웃, doctor 가 느려지지 않게).
  const [registry] = await Promise.all([
    probeRegistryReachability(options.fetchImpl),
    ...[...probes.entries()].map(async ([probe, [command, args]]) =>
      results.set(probe, await runner(command, args)),
    ),
  ]);
  const cachedRunner: DoctorRunner = (command, args) =>
    results.get(key(command, args)) ?? {
      ok: false,
      stdout: '',
      stderr: `probe was not prefetched: ${command} ${args.join(' ')}`,
    };
  return collectDoctorReport(options, cachedRunner, registry);
}
