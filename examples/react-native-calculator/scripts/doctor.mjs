import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeAutolinking,
  analyzeGeneratedArtifacts,
  analyzeRustArchive,
  compareSemanticVersions,
  fail,
  formatDoctorReport,
  pass,
} from './doctor-checks.mjs';
import {
  analyzeRuntime,
  commandError,
  defaultRunner,
  fileStat,
  newestInput,
  readOptional,
} from './doctor-runtime.mjs';
import { BUILD_FINGERPRINT_PATH, computeBuildFingerprint } from './generate-build-fingerprint.mjs';

export {
  analyzeAutolinking,
  analyzeGeneratedArtifacts,
  analyzeInstalledBinary,
  analyzeRustArchive,
  compareSemanticVersions,
  formatDoctorReport,
} from './doctor-checks.mjs';

export const MINIMUM_BUN_VERSION = '1.4.0';
export const DEFAULT_BUNDLE_ID = 'com.alt-shifted.react-native-calculator';

const DEFAULT_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_FINGERPRINT_PATTERN = /RUSTRA_BUILD_FINGERPRINT\s*=\s*['"]([a-f0-9]{64})['"]/;

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArguments(argv) {
  const known = new Set(['--json', '--device', '--bundle-id', '--app-root']);
  for (let index = 0; index < argv.length; index++) {
    if (!known.has(argv[index])) throw new Error(`unknown option: ${argv[index]}`);
    if (argv[index] !== '--json') index++;
  }
  return {
    appRoot: resolve(readFlag(argv, '--app-root', DEFAULT_APP_ROOT)),
    bundleId: readFlag(argv, '--bundle-id', DEFAULT_BUNDLE_ID),
    device: readFlag(argv, '--device', 'booted'),
    json: argv.includes('--json'),
  };
}

function dependencyCheck({ packageJson, typesVersion, expoInstalled }) {
  const valid =
    expoInstalled && typesVersion === '0.4.0' && packageJson.packageManager === 'bun@1.4.0';
  return valid
    ? pass('Bun', 'bun.dependencies', 'Bun dependencies and @rustra/types 0.4.0 are installed')
    : fail(
        'Bun',
        'bun.dependencies',
        'Dependency installation or pinned versions are inconsistent',
        `expo=${expoInstalled ? 'installed' : 'missing'}, @rustra/types=${typesVersion ?? 'missing'}, packageManager=${packageJson.packageManager ?? 'missing'}`,
        'Keep `packageManager` at `bun@1.4.0`, keep all `@rustra/*` packages at 0.4.0, and run `bun install`.',
      );
}

async function generatedChecks(appRoot, schemaPath, generatedRoot, nativeRoot) {
  const currentBuild = await computeBuildFingerprint(appRoot);
  const [fingerprintSource, schemaSource, contractSource, commandsSource, rnSource, cppSource] =
    await Promise.all([
      readOptional(join(appRoot, BUILD_FINGERPRINT_PATH)),
      readOptional(schemaPath),
      readOptional(join(generatedRoot, 'contract.ts')),
      readOptional(join(generatedRoot, 'commands.ts')),
      readOptional(join(generatedRoot, 'react-native.ts')),
      readOptional(join(nativeRoot, 'rustra-generated-codecs.cpp')),
    ]);
  const fingerprint = fingerprintSource?.match(BUILD_FINGERPRINT_PATTERN)?.[1];
  const checks = [
    fingerprint === currentBuild.fingerprint
      ? pass(
          'Generated',
          'generated.build-fingerprint',
          `Build fingerprint covers ${currentBuild.inputCount} current source inputs`,
          currentBuild.fingerprint,
        )
      : fail(
          'Generated',
          'generated.build-fingerprint',
          'Build fingerprint is stale or missing',
          `generated=${fingerprint?.slice(0, 16) ?? 'missing'}..., current=${currentBuild.fingerprint.slice(0, 16)}...`,
          'Run `bun run build:fingerprint`. `bun run ios` and `bun run android` do this automatically before native builds.',
        ),
  ];
  if (
    schemaSource &&
    contractSource &&
    commandsSource &&
    rnSource?.includes('createRustraBootstrap') &&
    cppSource
  ) {
    checks.push(
      ...analyzeGeneratedArtifacts({ schemaSource, contractSource, commandsSource, cppSource }),
    );
  } else {
    checks.push(
      fail(
        'Generated',
        'generated.files',
        'Required generated TypeScript or native codec files are missing',
        'Expected schema.json, contract.ts, commands.ts, react-native.ts, and rustra-generated-codecs.cpp.',
        'Run `bun run codegen` from examples/react-native-calculator.',
      ),
    );
  }
  return { checks, fingerprint: currentBuild.fingerprint };
}

async function rustChecks(repoRoot, archivePath, runner) {
  const requiredTargets = ['aarch64-apple-ios-sim', 'x86_64-apple-ios'];
  const rustup = runner('rustup', ['target', 'list', '--installed']);
  const installedTargets = new Set(rustup.stdout.split(/\s+/));
  const missingTargets = requiredTargets.filter((target) => !installedTargets.has(target));
  const checks = [
    rustup.ok && missingTargets.length === 0
      ? pass('Rust', 'rust.targets', 'Rust targets cover the universal iOS Simulator build')
      : fail(
          'Rust',
          'rust.targets',
          'Required Rust iOS Simulator targets are missing',
          missingTargets.length ? `missing: ${missingTargets.join(', ')}` : commandError(rustup),
          `Run \`rustup target add ${missingTargets.join(' ') || requiredTargets.join(' ')}\`, then \`bun run rust:ios\`.`,
        ),
  ];
  const archiveStat = await fileStat(archivePath);
  const newestSource = await newestInput([
    join(repoRoot, 'Cargo.toml'),
    join(repoRoot, 'Cargo.lock'),
    join(repoRoot, 'crates/rustra/Cargo.toml'),
    join(repoRoot, 'crates/rustra/src'),
    join(repoRoot, 'crates/rustra-macros/Cargo.toml'),
    join(repoRoot, 'crates/rustra-macros/src'),
    join(repoRoot, 'examples/calculator/Cargo.toml'),
    join(repoRoot, 'examples/calculator/src'),
  ]);
  const nm = archiveStat ? runner('nm', ['-gU', archivePath]) : { stdout: '' };
  const lipo = archiveStat ? runner('lipo', ['-info', archivePath]) : { ok: false, stdout: '' };
  checks.push(
    ...analyzeRustArchive({
      exists: Boolean(archiveStat),
      archiveMtimeMs: archiveStat?.mtimeMs ?? 0,
      newestSourceMtimeMs: newestSource.mtimeMs,
      newestSourcePath: newestSource.path?.replace(`${repoRoot}/`, ''),
      symbols: nm.stdout,
      architectures: lipo.ok ? lipo.stdout : '',
    }),
  );
  return { checks, archiveStat };
}

export async function runDoctor(options, runner = defaultRunner) {
  const { appRoot } = options;
  const repoRoot = resolve(appRoot, '../..');
  const packageJson = JSON.parse(await readOptional(join(appRoot, 'package.json')));
  const rustraConfig = JSON.parse(await readOptional(join(appRoot, 'rustra.json')));
  const generatedRoot = resolve(appRoot, rustraConfig.output);
  const schemaPath = resolve(appRoot, rustraConfig.schema);
  const moduleRoot = resolve(
    appRoot,
    rustraConfig.reactNative.moduleDir ?? 'modules/rustra-bridge',
  );
  const nativeRoot = resolve(appRoot, rustraConfig.cppOutput ?? join(moduleRoot, 'generated'));
  const iosBuild = await readOptional(join(moduleRoot, 'ios/build-rust-ios.sh'));
  const rustLibrary =
    rustraConfig.reactNative.rustLibrary ?? iosBuild?.match(/^LIBRARY='([^']+)'$/m)?.[1];
  if (!rustLibrary) {
    throw new Error('Generated iOS build script does not declare the inferred Rust library');
  }
  const archivePath = join(moduleRoot, `ios/rust/lib/lib${rustLibrary}.a`);
  const typesManifest = JSON.parse(await readOptional(join(repoRoot, 'packages/types/package.json')));
  const bunSupported = compareSemanticVersions(Bun.version, MINIMUM_BUN_VERSION) >= 0;
  const checks = [
    bunSupported
      ? pass('Bun', 'bun.version', `Bun ${Bun.version} satisfies >= ${MINIMUM_BUN_VERSION}`)
      : fail(
          'Bun',
          'bun.version',
          `Bun ${Bun.version ?? 'unknown'} is unsupported`,
          `required: >= ${MINIMUM_BUN_VERSION}`,
          'Upgrade Bun to 1.4 or newer, then run `bun install` so the lockfile and node_modules agree.',
        ),
    dependencyCheck({
      packageJson,
      typesVersion: typesManifest.version,
      expoInstalled: Boolean(await fileStat(join(appRoot, 'node_modules/.bin/expo'))),
    }),
  ];

  const generated = await generatedChecks(appRoot, schemaPath, generatedRoot, nativeRoot);
  checks.push(...generated.checks);
  const reactNativeConfig = runner('bunx', ['--bun', 'react-native', 'config']);
  const podfileLock = await readOptional(join(appRoot, 'ios/Podfile.lock'));
  checks.push(
    ...analyzeAutolinking({
      reactNativeConfig: reactNativeConfig.ok ? reactNativeConfig.stdout : '',
      podfileLock: podfileLock ?? '',
    }),
  );

  const rust = await rustChecks(repoRoot, archivePath, runner);
  checks.push(...rust.checks);
  checks.push(
    ...(await analyzeRuntime({
      runner,
      device: options.device,
      bundleId: options.bundleId,
      newestAppInput: {
        mtimeMs: rust.archiveStat?.mtimeMs ?? 0,
        path: archivePath.replace(`${repoRoot}/`, ''),
      },
      expectedBuildFingerprint: generated.fingerprint,
    })),
  );
  return {
    schemaVersion: 1,
    app: packageJson.name,
    appRoot,
    generatedAt: new Date().toISOString(),
    checks,
    summary: Object.fromEntries(
      ['pass', 'warn', 'fail'].map((status) => [
        status,
        checks.filter((item) => item.status === status).length,
      ]),
    ),
  };
}

export async function main(argv = Bun.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await runDoctor(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  if (report.summary.fail > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
