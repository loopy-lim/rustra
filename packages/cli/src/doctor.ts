import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

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
    (check) => check.status === 'fail' || (strict && check.status === 'warn'),
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

function commandCheck(
  runner: DoctorRunner,
  command: string,
  args: string[],
  id: string,
  summary: string,
  fix: string[],
): DoctorCheck {
  const result = runner(command, args);
  return result.ok
    ? check(id, 'pass', true, summary)
    : check(id, 'fail', true, `${summary} is unavailable`, result.stderr || result.error, fix);
}

function readConfig(configPath: string): { config?: DoctorConfig; error?: string } {
  try {
    const value = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: 'config must be a JSON object' };
    }
    return { config: value as DoctorConfig };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function findCargoManifest(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, 'Cargo.toml');
    if (existsSync(candidate)) return candidate;
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
  const manifest = resolve(manifestPath);
  const packages = (metadata.packages ?? []).filter((candidate) => {
    if (requestedPackage && candidate.name !== requestedPackage) return false;
    return requestedPackage || resolve(candidate.manifest_path ?? '') === manifest;
  });
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
  const selected = requestedBinary
    ? binaries.find((target) => target.name === requestedBinary)
    : (binaries.find((target) => target.name === 'generate') ??
      (binaries.length === 1 ? binaries[0] : undefined));
  if (!selected?.name) {
    return {
      error: `could not select one Cargo binary from ${
        binaries
          .map((target) => target.name)
          .filter(Boolean)
          .join(', ') || 'none'
      }`,
    };
  }
  return { packageName: candidate.name, binaryName: selected.name };
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
    java.ok && javaVersion === 17
      ? check('rn.android.java', 'pass', true, 'Java 17 is available')
      : check(
          'rn.android.java',
          'fail',
          true,
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
    sdkmanager.ok
      ? check('rn.android.sdkmanager', 'pass', true, 'Android sdkmanager is available')
      : check(
          'rn.android.sdkmanager',
          'fail',
          true,
          'Android sdkmanager is unavailable',
          sdkmanager.stderr || sdkmanager.error,
          ['Install Android command-line tools and ensure sdkmanager is on PATH'],
        ),
  );
  const ndk = ndkPath(env);
  checks.push(
    ndk
      ? check('rn.android.ndk', 'pass', true, `Android NDK ${ANDROID_NDK_VERSION} is available`)
      : check(
          'rn.android.ndk',
          'fail',
          true,
          `Android NDK ${ANDROID_NDK_VERSION} is missing`,
          'Set ANDROID_NDK_HOME or ANDROID_HOME/ANDROID_SDK_ROOT to an SDK containing the pinned NDK',
          [`sdkmanager "ndk;${ANDROID_NDK_VERSION}"`],
        ),
  );
  const targets = runner('rustup', ['target', 'list', '--installed']);
  const installed = new Set(targets.stdout.split(/\r?\n/).map((target) => target.trim()));
  const missing = DEFAULT_ANDROID_TARGETS.filter((target) => !installed.has(target));
  checks.push(
    targets.ok && missing.length === 0
      ? check('rn.android.rust_targets', 'pass', true, 'Android Rust targets are installed')
      : check(
          'rn.android.rust_targets',
          'fail',
          true,
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
    rustc.ok
      ? check('rustc.present', 'pass', true, 'rustc is available')
      : check('rustc.present', 'fail', true, 'rustc is unavailable', rustc.stderr || rustc.error, [
          'Install Rust with https://rustup.rs',
        ]),
  );
  const rustVersion = parseRustVersion(`${rustc.stdout}\n${rustc.stderr}`);
  checks.push(
    rustc.ok && rustVersion && isVersionAtLeast(rustVersion, RUSTRA_MSRV)
      ? check('rustc.msrv', 'pass', true, `Rust ${rustVersion.join('.')} satisfies MSRV 1.88`)
      : check(
          'rustc.msrv',
          'fail',
          true,
          `Rust 1.88 or newer is required${rustVersion ? ` (found ${rustVersion.join('.')})` : ''}`,
          rustc.stderr || rustc.error,
          ['rustup toolchain install 1.88.0', 'rustup default 1.88.0'],
        ),
  );
  const cargo = runner('cargo', ['--version']);
  checks.push(
    cargo.ok
      ? check('cargo.present', 'pass', true, 'cargo is available')
      : check('cargo.present', 'fail', true, 'cargo is unavailable', cargo.stderr || cargo.error, [
          'Install Cargo with https://rustup.rs',
        ]),
  );
  const node = runner('node', ['--version']);
  const bun = runner('bun', ['--version']);
  checks.push(
    node.ok || bun.ok
      ? check('js.runtime', 'pass', true, node.ok ? 'Node.js is available' : 'Bun is available')
      : check(
          'js.runtime',
          'fail',
          true,
          'Node.js or Bun is unavailable',
          node.stderr || bun.stderr || node.error || bun.error,
          ['Install Node.js 18+ or Bun 1.4+'],
        ),
  );

  if (config) {
    const manifestPath = resolveManifest(configRoot, config);
    checks.push(
      manifestPath
        ? check('codegen.rust_manifest', 'pass', true, `Cargo manifest: ${manifestPath}`)
        : check(
            'codegen.rust_manifest',
            'fail',
            true,
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
          selected.binaryName
            ? check(
                'codegen.rust_binary',
                'pass',
                true,
                `Rust generator: ${selected.packageName ?? 'package'} / ${selected.binaryName}`,
              )
            : check(
                'codegen.rust_binary',
                'fail',
                true,
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
        ? check('codegen.schema_output', 'pass', true, `Schema exists: ${schemaPath}`)
        : check(
            'codegen.schema_output',
            'warn',
            false,
            `Schema is not generated yet: ${schemaPath ?? 'invalid schema path'}`,
            undefined,
            ['Run rustra codegen --config rustra.json'],
          ),
    );
    if (outputPath && !existsSync(outputPath)) {
      checks.push(
        check(
          'codegen.output_directory',
          'warn',
          false,
          `Generated output directory will be created: ${outputPath}`,
        ),
      );
    }

    const platform = options.platform ?? process.platform;
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
