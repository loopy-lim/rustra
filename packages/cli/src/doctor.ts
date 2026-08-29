import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { cargoPackagesForManifest, findCargoManifest, selectCodegenBinary } from './cargo.js';
import { readConfigSync } from './config.js';

export const RUSTRA_MSRV: [number, number, number] = [1, 88, 0];
export const ANDROID_NDK_VERSION = '27.1.12297006';
const DEFAULT_ANDROID_TARGETS = ['aarch64-linux-android', 'x86_64-linux-android'];

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

interface DoctorConfig {
  schema?: string;
  output?: string;
  cppOutput?: string;
  codegen?: {
    rustManifest?: string;
    rustPackage?: string;
    rustBinary?: string;
  };
  reactNative?: Record<string, unknown>;
  node?: Record<string, unknown>;
  bun?: Record<string, unknown>;
  tauri?: Record<string, unknown>;
}

interface CargoMetadata {
  packages?: Array<{
    name?: string;
    manifest_path?: string;
    targets?: Array<{
      name?: string;
      kind?: string[];
      crate_types?: string[];
    }>;
  }>;
}

export function parseDoctorArgs(args: string[]): DoctorCliOptions {
  const result: DoctorCliOptions = { configPath: 'rustra.json', format: 'text', strict: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--config':
        result.configPath = args[++index] ?? '';
        break;
      case '--format': {
        const format = args[++index];
        if (format !== 'text' && format !== 'json') {
          throw new Error('doctor --format must be text or json');
        }
        result.format = format;
        break;
      }
      case '--strict':
        result.strict = true;
        break;
      default:
        throw new Error(`Unknown doctor option: ${args[index]}`);
    }
  }
  if (!result.configPath) throw new Error('doctor --config requires a path');
  return result;
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

/** Async probe used by the CLI so independent native checks run concurrently. */
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

function memoizeRunner(runner: DoctorRunner): DoctorRunner {
  const cache = new Map<string, DoctorCommandResult>();
  return (command, args) => {
    const key = JSON.stringify([command, args]);
    const cached = cache.get(key);
    if (cached) return cached;
    const result = runner(command, args);
    cache.set(key, result);
    return result;
  };
}

function check(
  id: string,
  status: DoctorStatus,
  required: boolean,
  summary: string,
  detail?: string,
  fix?: string[],
): DoctorCheck {
  return { id, status, required, summary, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
}

function conditionalCheck(
  id: string,
  required: boolean,
  condition: boolean,
  passSummary: string,
  failSummary: string,
  detail?: string,
  fix?: string[],
): DoctorCheck {
  return condition
    ? check(id, 'pass', required, passSummary)
    : check(id, 'fail', required, failSummary, detail, fix);
}

function commandCheck(
  runner: DoctorRunner,
  command: string,
  args: string[],
  id: string,
  summary: string,
  fix: string[],
): DoctorCheck {
  const result = runner(command, args);
  return conditionalCheck(
    id,
    true,
    result.ok,
    summary,
    `${summary} is unavailable`,
    result.stderr || result.error,
    fix,
  );
}

function readConfig(configPath: string): { config?: DoctorConfig; error?: string } {
  try {
    return { config: readConfigSync(configPath) as DoctorConfig };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingParent(path: string): string | undefined {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function safeResolve(root: string, value: string | undefined): string | undefined {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) return undefined;
  return resolve(root, value);
}

function resolveManifest(configRoot: string, config: DoctorConfig): string | undefined {
  return safeResolve(configRoot, config.codegen?.rustManifest) ?? findCargoManifest(configRoot);
}

function getCargoMetadata(
  runner: DoctorRunner,
  manifestPath: string,
): { metadata?: CargoMetadata; error?: string } {
  const result = runner('cargo', [
    'metadata',
    '--format-version',
    '1',
    '--no-deps',
    '--manifest-path',
    manifestPath,
  ]);
  if (!result.ok) return { error: result.stderr || result.error || 'cargo metadata failed' };
  try {
    return { metadata: JSON.parse(result.stdout) as CargoMetadata };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function selectGenerator(
  metadata: CargoMetadata,
  manifestPath: string,
  requestedPackage: string | undefined,
  requestedBinary: string | undefined,
): { packageName?: string; binaryName?: string; error?: string } {
  const packages = cargoPackagesForManifest(
    metadata.packages ?? [],
    manifestPath,
    requestedPackage,
  );
  if (packages.length !== 1) {
    return {
      error:
        packages.length === 0
          ? 'no Cargo package matches the configured manifest/package'
          : `multiple Cargo packages match: ${packages.map((candidate) => candidate.name).join(', ')}`,
    };
  }
  const candidate = packages[0]!;
  const binaries = (candidate.targets ?? []).filter(
    (target) => target.kind?.includes('bin') || target.crate_types?.includes('bin'),
  );
  const validBinaries = binaries.filter(
    (target): target is { name: string; kind?: string[]; crate_types?: string[] } =>
      typeof target.name === 'string',
  );
  let binaryName: string;
  try {
    binaryName = selectCodegenBinary(validBinaries, requestedBinary);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { packageName: candidate.name, binaryName };
}

function javaMajor(value: string): number | null {
  const match = /version\s+["'](\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 && match[2] ? Number(match[2]) : major;
}

function ndkPath(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.ANDROID_NDK_HOME;
  if (direct && existsSync(join(direct, 'source.properties'))) return direct;
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (!sdk) continue;
    const candidate = join(sdk, 'ndk', ANDROID_NDK_VERSION);
    if (existsSync(join(candidate, 'source.properties'))) return candidate;
  }
  return undefined;
}

function addAndroidChecks(
  checks: DoctorCheck[],
  runner: DoctorRunner,
  env: NodeJS.ProcessEnv,
): void {
  const java = runner('java', ['-version']);
  const javaVersion = javaMajor(`${java.stdout}\n${java.stderr}`);
  checks.push(
    conditionalCheck(
      'rn.android.java',
      true,
      java.ok && javaVersion === 17,
      'Java 17 is available',
      `Java 17 is required${javaVersion ? ` (found ${javaVersion})` : ''}`,
      java.stderr || java.error,
      ['Install Java 17 and set JAVA_HOME'],
    ),
  );
  checks.push(
    commandCheck(runner, 'adb', ['version'], 'rn.android.sdk', 'Android SDK adb', [
      'Install Android SDK platform tools and ensure adb is on PATH',
    ]),
  );
  const sdkmanager = runner('sdkmanager', ['--version']);
  checks.push(
    conditionalCheck(
      'rn.android.sdkmanager',
      true,
      sdkmanager.ok,
      'Android sdkmanager is available',
      'Android sdkmanager is unavailable',
      sdkmanager.stderr || sdkmanager.error,
      ['Install Android command-line tools and ensure sdkmanager is on PATH'],
    ),
  );
  const ndk = ndkPath(env);
  checks.push(
    conditionalCheck(
      'rn.android.ndk',
      true,
      Boolean(ndk),
      `Android NDK ${ANDROID_NDK_VERSION} is available`,
      `Android NDK ${ANDROID_NDK_VERSION} is missing`,
      'Set ANDROID_NDK_HOME or ANDROID_HOME/ANDROID_SDK_ROOT to an SDK containing the pinned NDK',
      [`sdkmanager "ndk;${ANDROID_NDK_VERSION}"`],
    ),
  );
  const targets = runner('rustup', ['target', 'list', '--installed']);
  const installed = new Set(targets.stdout.split(/\r?\n/).map((target) => target.trim()));
  const missing = DEFAULT_ANDROID_TARGETS.filter((target) => !installed.has(target));
  checks.push(
    conditionalCheck(
      'rn.android.rust_targets',
      true,
      targets.ok && missing.length === 0,
      'Android Rust targets are installed',
      `Missing Android Rust targets: ${missing.join(', ')}`,
      targets.stderr || targets.error,
      [`rustup target add ${missing.join(' ')}`],
    ),
  );
}

export function collectDoctorReport(
  options: DoctorOptions,
  runner: DoctorRunner = defaultDoctorRunner,
): DoctorReport {
  runner = memoizeRunner(runner);
  const configPath = resolve(options.configPath);
  const configRoot = dirname(configPath);
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  let config: DoctorConfig | undefined;

  if (!existsSync(configPath)) {
    checks.push(
      check('config.file', 'fail', true, `Config file does not exist: ${configPath}`, undefined, [
        'Create rustra.json or pass --config <path>',
      ]),
    );
  } else {
    const parsed = readConfig(configPath);
    if (!parsed.config) {
      checks.push(check('config.file', 'fail', true, 'Config file is invalid JSON', parsed.error));
    } else {
      config = parsed.config;
      checks.push(check('config.file', 'pass', true, `Config file is readable: ${configPath}`));
    }
  }

  const rustc = runner('rustc', ['--version']);
  checks.push(
    conditionalCheck(
      'rustc.present',
      true,
      rustc.ok,
      'rustc is available',
      'rustc is unavailable',
      rustc.stderr || rustc.error,
      ['Install Rust with https://rustup.rs'],
    ),
  );
  const rustVersion = parseRustVersion(`${rustc.stdout}\n${rustc.stderr}`);
  checks.push(
    conditionalCheck(
      'rustc.msrv',
      true,
      Boolean(rustc.ok && rustVersion && isVersionAtLeast(rustVersion, RUSTRA_MSRV)),
      rustVersion
        ? `Rust ${rustVersion.join('.')} satisfies MSRV 1.88`
        : 'Rust satisfies MSRV 1.88',
      `Rust 1.88 or newer is required${rustVersion ? ` (found ${rustVersion.join('.')})` : ''}`,
      rustc.stderr || rustc.error,
      ['rustup toolchain install 1.88.0', 'rustup default 1.88.0'],
    ),
  );
  const cargo = runner('cargo', ['--version']);
  checks.push(
    conditionalCheck(
      'cargo.present',
      true,
      cargo.ok,
      'cargo is available',
      'cargo is unavailable',
      cargo.stderr || cargo.error,
      ['Install Cargo with https://rustup.rs'],
    ),
  );
  const node = runner('node', ['--version']);
  const bun = runner('bun', ['--version']);
  checks.push(
    conditionalCheck(
      'js.runtime',
      true,
      node.ok || bun.ok,
      node.ok ? 'Node.js is available' : 'Bun is available',
      'Node.js or Bun is unavailable',
      node.stderr || bun.stderr || node.error || bun.error,
      ['Install Node.js 18+ or Bun 1.4+'],
    ),
  );
  const platform = options.platform ?? process.platform;
  const compilerCommand = platform === 'win32' ? 'cl' : 'c++';
  const compilerArgs = platform === 'win32' ? ['/Bv'] : ['--version'];
  checks.push(
    commandCheck(runner, compilerCommand, compilerArgs, 'toolchain.cpp', 'C/C++ compiler', [
      platform === 'win32'
        ? 'Open a Visual Studio Developer Command Prompt or install the MSVC C++ workload'
        : 'Install the platform C++ compiler (Xcode Command Line Tools or build-essential)',
    ]),
  );
  checks.push(
    commandCheck(runner, 'cmake', ['--version'], 'toolchain.cmake', 'CMake', [
      'Install CMake and ensure it is on PATH',
    ]),
  );

  if (config) {
    const manifestPath = resolveManifest(configRoot, config);
    checks.push(
      conditionalCheck(
        'codegen.rust_manifest',
        true,
        Boolean(manifestPath),
        `Cargo manifest: ${manifestPath ?? ''}`,
        'Could not find Cargo.toml for codegen',
        undefined,
        ['Set codegen.rustManifest in rustra.json'],
      ),
    );
    if (manifestPath && existsSync(manifestPath) && cargo.ok) {
      const metadataResult = getCargoMetadata(runner, manifestPath);
      if (metadataResult.metadata) {
        const selected = selectGenerator(
          metadataResult.metadata,
          manifestPath,
          config.codegen?.rustPackage,
          config.codegen?.rustBinary,
        );
        checks.push(
          conditionalCheck(
            'codegen.rust_binary',
            true,
            Boolean(selected.binaryName),
            `Rust generator: ${selected.packageName ?? 'package'} / ${selected.binaryName ?? ''}`,
            'Could not select a Cargo generator binary',
            selected.error,
            ['Set codegen.rustPackage and codegen.rustBinary in rustra.json'],
          ),
        );
      } else {
        checks.push(
          check(
            'codegen.rust_binary',
            'fail',
            true,
            'Cargo metadata could not inspect the generator',
            metadataResult.error,
            ['Run cargo metadata manually and fix the Cargo manifest'],
          ),
        );
      }
    } else {
      checks.push(
        check(
          'codegen.rust_binary',
          'skip',
          true,
          'Skipped Cargo binary selection because the manifest or cargo is unavailable',
        ),
      );
    }
    const schemaPath = safeResolve(configRoot, config.schema);
    const outputPath = safeResolve(configRoot, config.output);
    checks.push(
      schemaPath && existsSync(schemaPath)
        ? conditionalCheck(
            'codegen.schema_output',
            true,
            statSync(schemaPath).isFile() && canAccess(schemaPath, constants.R_OK),
            `Schema exists and is readable: ${schemaPath}`,
            `Schema exists but is not readable: ${schemaPath}`,
            undefined,
            ['Check file permissions for schema.json'],
          )
        : check(
            'codegen.schema_output',
            'warn',
            false,
            `Schema is not generated yet: ${schemaPath ?? 'invalid schema path'}`,
            undefined,
            ['Run rustra codegen --config rustra.json'],
          ),
    );
    if (outputPath && existsSync(outputPath)) {
      checks.push(
        conditionalCheck(
          'codegen.output_directory',
          true,
          statSync(outputPath).isDirectory() && canAccess(outputPath, constants.W_OK),
          `Generated output directory is writable: ${outputPath}`,
          `Generated output directory is not writable: ${outputPath}`,
          undefined,
          ['Check directory permissions for generated output'],
        ),
      );
    } else if (outputPath) {
      const parent = nearestExistingParent(dirname(outputPath));
      const parentWritable = parent !== undefined && canAccess(parent, constants.W_OK);
      checks.push(
        check(
          'codegen.output_directory',
          'warn',
          false,
          parentWritable
            ? `Generated output directory will be created: ${outputPath}`
            : `Generated output directory may not be creatable: ${outputPath}`,
          parentWritable
            ? undefined
            : `Nearest existing parent is not writable: ${parent ?? dirname(outputPath)}`,
          ['Create the output directory or grant write permission'],
        ),
      );
    }

    if (config.reactNative) {
      if (platform === 'darwin') {
        checks.push(
          check('rn.ios.platform', 'pass', true, 'macOS is available for React Native iOS builds'),
        );
        checks.push(
          commandCheck(runner, 'xcodebuild', ['-version'], 'rn.ios.xcodebuild', 'Xcode', [
            'Install Xcode and run xcode-select --install',
          ]),
        );
        checks.push(
          commandCheck(runner, 'pod', ['--version'], 'rn.ios.cocoapods', 'CocoaPods', [
            'Install CocoaPods with gem install cocoapods',
          ]),
        );
      } else {
        checks.push(
          check('rn.ios.platform', 'skip', false, 'React Native iOS build requires macOS'),
        );
      }
      addAndroidChecks(checks, runner, env);
    }

    if (config.tauri) {
      const platformCommand =
        platform === 'darwin' ? 'xcodebuild' : platform === 'win32' ? 'cl' : 'pkg-config';
      const platformArgs =
        platformCommand === 'xcodebuild'
          ? ['-version']
          : platformCommand === 'pkg-config'
            ? ['--version']
            : [];
      checks.push(
        commandCheck(
          runner,
          platformCommand,
          platformArgs,
          'tauri.platform_tools',
          `Tauri ${platform} build tools`,
          ['Install the native build tools required by the current platform'],
        ),
      );
    }
  }

  return { schemaVersion: 1, checks };
}

function doctorProbeKey(command: string, args: string[]): string {
  return JSON.stringify([command, args]);
}

/**
 * Async doctor collection for the CLI. Probe discovery is deliberately kept
 * separate from report assembly: the existing synchronous collector remains a
 * stable library API, while independent native commands are started together
 * and then replayed from one result cache.
 */
export async function collectDoctorReportAsync(
  options: DoctorOptions,
  runner: DoctorAsyncRunner = defaultDoctorRunnerAsync,
): Promise<DoctorReport> {
  const probes = new Map<string, [string, string[]]>();
  const add = (command: string, args: string[]) => {
    probes.set(doctorProbeKey(command, args), [command, args]);
  };

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
      const manifestPath = resolveManifest(configRoot, parsed.config);
      if (manifestPath) {
        add('cargo', [
          'metadata',
          '--format-version',
          '1',
          '--no-deps',
          '--manifest-path',
          manifestPath,
        ]);
      }

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
        const args =
          command === 'xcodebuild' ? ['-version'] : command === 'pkg-config' ? ['--version'] : [];
        add(command, args);
      }
    }
  }

  const results = new Map<string, DoctorCommandResult>();
  await Promise.all(
    [...probes.entries()].map(async ([key, [command, args]]) => {
      results.set(key, await runner(command, args));
    }),
  );
  const cachedRunner: DoctorRunner = (command, args) =>
    results.get(doctorProbeKey(command, args)) ?? {
      ok: false,
      stdout: '',
      stderr: `probe was not prefetched: ${command} ${args.join(' ')}`,
    };
  return collectDoctorReport(options, cachedRunner);
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

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
