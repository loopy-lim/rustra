import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseCliArgs } from './cli-arg-parser.js';
import { runCodegen } from './cli-codegen.js';
import { UsageError } from './cli-usage-error.js';
import { readConfigSync, type RustraConfig } from './config.js';
import { collectBaseChecks } from './doctor-base-checks.js';
import { defaultDoctorRunner, type DoctorRunner } from './doctor-types.js';
import { spawnInherit } from './process.js';
import { resolveSetupBuilds } from './setup-builds.js';
import { cliManifest } from './cli-runtime.js';
import { ensureReactNativeAdapter, prepareReactNativeHost } from './react-native-host.js';
import { setupTauriIntegration } from './setup-tauri.js';

const PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

interface ProjectManifest {
  packageManager?: unknown;
  scripts?: Record<string, string>;
}

/** Test seams are stage boundaries; production uses the same codegen and build paths. */
export interface SetupServices {
  preflight(
    configPath: string,
    config: RustraConfig,
    manager: PackageManager,
    needsManager: boolean,
  ): void;
  bootstrap(configPath: string, config: RustraConfig): Promise<boolean>;
  codegen: typeof runCodegen;
  native(configPath: string, config: RustraConfig, manager: PackageManager): Promise<string[]>;
  builds: typeof resolveSetupBuilds;
  spawn: typeof spawnInherit;
}

function packageManager(manifest: ProjectManifest, root: string): PackageManager {
  if (manifest.packageManager === undefined) {
    const locks: Record<PackageManager, string[]> = {
      bun: ['bun.lock', 'bun.lockb'],
      npm: ['package-lock.json', 'npm-shrinkwrap.json'],
      pnpm: ['pnpm-lock.yaml'],
      yarn: ['yarn.lock'],
    };
    const managers = PACKAGE_MANAGERS.filter((name) =>
      locks[name].some((file) => existsSync(resolve(root, file))),
    );
    if (managers.length > 1)
      throw new UsageError(
        'Multiple package-manager lockfiles found. Set package.json packageManager to select one.',
      );
    if (managers[0]) return managers[0];
    return defaultDoctorRunner('bun', ['--version']).ok ? 'bun' : 'npm';
  }
  const name =
    typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
  if (!PACKAGE_MANAGERS.includes(name as PackageManager)) {
    throw new UsageError(
      `Unsupported packageManager ${String(manifest.packageManager)}. Use ${PACKAGE_MANAGERS.join(', ')}.`,
    );
  }
  return name as PackageManager;
}

export function checkSetupTools(
  configPath: string,
  config: RustraConfig,
  manager: PackageManager,
  needsManager: boolean,
  runner: DoctorRunner = defaultDoctorRunner,
): void {
  const failed = collectBaseChecks(
    { configPath, strict: false },
    runner,
    undefined,
    // Mobile SDK/compiler checks belong to rustra:ios/rustra:android, not host preparation.
    { node: config.node, bun: config.bun },
  ).filter((check) => check.required && check.status === 'fail');
  if (failed.length) {
    throw new Error(
      failed.map((check) => `${check.summary}\n${(check.fix ?? []).join('\n')}`).join('\n'),
    );
  }
  if (needsManager && !runner(manager, ['--version']).ok) {
    throw new Error(
      `${manager} is not available on PATH. Install ${manager} or update package.json packageManager.`,
    );
  }
}

function rnOptions(configPath: string, config: RustraConfig) {
  const appRoot = dirname(configPath);
  const moduleDir = resolve(appRoot, config.reactNative?.moduleDir ?? 'modules/rustra-bridge');
  const moduleRelative = relative(appRoot, moduleDir);
  if (
    isAbsolute(moduleRelative) ||
    moduleRelative === '..' ||
    moduleRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('Config reactNative.moduleDir must stay inside the app directory');
  }
  return { appRoot, moduleDir };
}

async function bootstrapAdapter(configPath: string, config: RustraConfig): Promise<boolean> {
  if (!config.reactNative) return false;
  const result = await ensureReactNativeAdapter({
    ...rnOptions(configPath, config),
    adapterRange: cliManifest.rustraTemplate.reactNativeRange,
  });
  return result.needsInstall;
}

async function prepareNative(
  configPath: string,
  config: RustraConfig,
  manager: PackageManager,
): Promise<string[]> {
  const instructions: string[] = [];
  if (config.reactNative) {
    const result = await prepareReactNativeHost(rnOptions(configPath, config));
    for (const script of result.scripts) {
      const conflict = result.conflicts.find((entry) => entry.name === script.name);
      instructions.push(
        conflict
          ? `${script.name} is already customized. Prepare with: ${script.command}`
          : `${manager} run ${script.name}  # prepare ${script.name.endsWith('ios') ? 'iOS Pods' : 'an Android debug build'}`,
      );
    }
    instructions.push(...result.followup.slice(1));
  }
  if (config.tauri) {
    const result = await setupTauriIntegration(configPath);
    instructions.push(...result.instructions);
  }
  return instructions;
}

/** Generate → install → build is deliberate: RN's local module must exist before install. */
export async function runSetup(
  args: string[],
  overrides: Partial<SetupServices> = {},
): Promise<void> {
  const parsed = parseCliArgs(args, {
    command: 'setup',
    valueFlags: ['config'],
    booleanFlags: ['run', 'skip-install', 'help'],
  });
  if (parsed.flags.has('help')) return;
  const configPath = resolve(parsed.values.get('config') ?? 'rustra.json');
  const config = readConfigSync(configPath);
  const root = dirname(configPath);
  const run = parsed.flags.has('run');
  const skipInstall = parsed.flags.has('skip-install');
  if (run && !config.node && !config.bun) {
    throw new UsageError(
      'setup --run requires a Node or Bun host. For native apps, run setup then launch your app.',
    );
  }
  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as ProjectManifest;
  } catch (error) {
    throw new Error(`Setup needs a readable package.json next to ${configPath}`, { cause: error });
  }
  const manager = packageManager(manifest, root);
  if (run && !manifest.scripts?.demo) {
    throw new UsageError(
      'setup --run needs a "demo" script in package.json. Add your first-call script or run setup without --run.',
    );
  }
  const services: SetupServices = {
    preflight: checkSetupTools,
    bootstrap: bootstrapAdapter,
    codegen: runCodegen,
    native: prepareNative,
    builds: resolveSetupBuilds,
    spawn: spawnInherit,
    ...overrides,
  };
  const quotedConfig = `'${configPath.replaceAll("'", "'\\''")}'`;
  const retry = `rustra setup --config ${quotedConfig}${skipInstall ? ' --skip-install' : ''}${run ? ' --run' : ''}`;
  let stage = 'preflight';
  try {
    console.log('[rustra] Checking setup tools...');
    services.preflight(configPath, config, manager, !skipInstall || run);
    if (!skipInstall) {
      stage = 'adapter bootstrap';
      if (await services.bootstrap(configPath, config)) {
        await services.spawn(manager, ['install'], root, { progressLabel: 'React Native adapter' });
      }
    }
    stage = 'generate';
    console.log('[rustra] Generating the Rust contract and TypeScript calls...');
    await services.codegen(['--config', configPath]);
    stage = 'native integration';
    const instructions = await services.native(configPath, config, manager);
    if (!skipInstall) {
      stage = 'install';
      await services.spawn(manager, ['install'], root, {
        progressLabel: 'JavaScript dependencies',
      });
    }
    stage = 'build';
    for (const build of services.builds(configPath, config)) {
      await services.spawn(
        'cargo',
        ['build', '--manifest-path', build.manifestPath, '--package', build.packageName],
        build.cwd ?? root,
        {
          progressLabel: `Rust runtime (${build.packageName})`,
        },
      );
    }
    if (run) {
      stage = 'first call';
      await services.spawn(manager, ['run', 'demo'], root, { progressLabel: 'First Rust call' });
    }
    console.log(
      run
        ? '[rustra] Setup complete — demo succeeded.'
        : '[rustra] Rust contract, TypeScript calls and host Rust build are ready.',
    );
    if (instructions.length) {
      console.log('\nNative app steps:');
      for (const instruction of instructions) console.log(`  ${instruction}`);
    }
  } catch (error) {
    throw new Error(
      `Setup stopped during ${stage}: ${error instanceof Error ? error.message : String(error)}\nFix the error above, then retry:\n  ${retry}\nRetry setup directly; init --force is not needed.`,
      { cause: error },
    );
  }
}
