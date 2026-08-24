import { createHash } from 'node:crypto';

export const REQUIRED_ARCHIVE_SYMBOLS = [
  'rustra_mobile_init',
  'rustra_ffi_invoke_buffer',
  'rustra_ffi_has_buffer',
  'rustra_ffi_invoke_raw',
  'rustra_ffi_has_raw',
  'rustra_ffi_free_owned_bytes',
  'rustra_ffi_invoke_rkyv_v2_async',
  'rustra_calculator_invoke_rkyv_v2',
  'rustra_calculator_invoke_typed_raw',
  'rustra_calculator_free_rkyv_v2_buffer',
];
const REQUIRED_INSTALLED_SYMBOLS = REQUIRED_ARCHIVE_SYMBOLS.filter(
  (symbol) => symbol !== 'rustra_calculator_invoke_typed_raw',
);

function check(status, layer, id, summary, details, fix) {
  return { status, layer, id, summary, details, fix };
}
export const pass = (layer, id, summary, details) =>
  check('pass', layer, id, summary, details);
export const warn = (layer, id, summary, details, fix) =>
  check('warn', layer, id, summary, details, fix);
export const fail = (layer, id, summary, details, fix) =>
  check('fail', layer, id, summary, details, fix);

function versionParts(version) {
  return String(version)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
}

export function compareSemanticVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const contractHash = (source) =>
  source.match(/GENERATED_CONTRACT_HASH\s*=\s*['"]([a-f0-9]{64})['"]/)?.[1];
const validCommands = (schema) =>
  Array.isArray(schema?.commands)
    ? schema.commands.filter(
        (command) => typeof command?.name === 'string' && Number.isInteger(command?.commandId),
      )
    : [];

export function analyzeGeneratedArtifacts({ schemaSource, contractSource, commandsSource, cppSource }) {
  let schema;
  try {
    schema = JSON.parse(schemaSource);
  } catch (error) {
    return [
      fail(
        'Generated',
        'generated.schema',
        'schema.json is not valid JSON',
        error instanceof Error ? error.message : String(error),
        'Run `bun run codegen` and inspect the Rust schema generation error.',
      ),
    ];
  }

  const expectedHash = sha256(schemaSource);
  const actualHash = contractHash(contractSource);
  const commands = validCommands(schema);
  const missingTypeScript = commands
    .map(({ name }) => name)
    .filter((name) => !new RegExp(`export (?:const|function) ${name}\\b`).test(commandsSource));
  const missingNative = commands.filter(
    ({ name, commandId }) =>
      !cppSource.includes(`if (name == "${name}")`) ||
      !new RegExp(`case\\s+${commandId}:`).test(cppSource),
  );
  return [
    actualHash === expectedHash
      ? pass('Generated', 'generated.contract', 'TypeScript contract matches schema.json', expectedHash)
      : fail(
          'Generated',
          'generated.contract',
          'TypeScript contract is stale',
          `schema=${expectedHash.slice(0, 16)}..., contract=${actualHash?.slice(0, 16) ?? 'missing'}...`,
          'Run `bun run codegen`. This regenerates the Rust schema, TypeScript client, and native C++ codecs together.',
        ),
    commands.length > 0 && missingTypeScript.length === 0
      ? pass(
          'Generated',
          'generated.commands',
          `Generated TypeScript exports all ${commands.length} Rust commands`,
        )
      : fail(
          'Generated',
          'generated.commands',
          'Generated TypeScript command surface is incomplete',
          missingTypeScript.length ? `missing: ${missingTypeScript.join(', ')}` : 'schema contains no command ids',
          'Run `bun run codegen`. If a command is still absent, check its `#[rustra::command]` registration in Rust.',
        ),
    commands.length > 0 && missingNative.length === 0
      ? pass(
          'Native codec',
          'native.codecs',
          `Native C++ codecs cover all ${commands.length} Rust command ids`,
        )
      : fail(
          'Native codec',
          'native.codecs',
          'Native C++ codecs do not match the Rust schema',
          missingNative.length
            ? `missing: ${missingNative.map(({ name, commandId }) => `${name}#${commandId}`).join(', ')}`
            : 'schema contains no command ids',
          'Run `bun run codegen`, then `bun run test:cpp-codec`. Do not benchmark until this check passes.',
        ),
  ];
}

const missingSymbols = (required, symbols) =>
  required.filter((symbol) => !new RegExp(`(?:_|\\b)${symbol}\\b`).test(symbols));

export function analyzeRustArchive({
  exists,
  archiveMtimeMs,
  newestSourceMtimeMs,
  newestSourcePath,
  symbols,
  architectures,
}) {
  if (!exists) {
    return [
      fail(
        'Rust',
        'rust.archive',
        'Rust static archive is missing',
        'librustra_calculator_example.a was not found',
        'Run `bun run rust:ios`. If compilation fails, first install the targets printed by the Rust target check.',
      ),
    ];
  }
  const absentSymbols = missingSymbols(REQUIRED_ARCHIVE_SYMBOLS, symbols);
  const absentArchitectures = ['arm64', 'x86_64'].filter(
    (architecture) => !architectures.includes(architecture),
  );
  return [
    archiveMtimeMs < newestSourceMtimeMs
      ? fail(
          'Rust',
          'rust.archive.freshness',
          'Rust static archive is stale',
          `newer input: ${newestSourcePath ?? 'unknown Rust source'}`,
          'Run `bun run rust:ios`, then rebuild the app. A JS reload cannot replace stale Rust symbols.',
        )
      : pass('Rust', 'rust.archive.freshness', 'Rust static archive is newer than its inputs'),
    absentSymbols.length
      ? fail(
          'Rust ABI',
          'rust.archive.symbols',
          'Rust archive is missing required native symbols',
          `missing: ${absentSymbols.join(', ')}`,
          'Run `bun run rust:ios`. If symbols remain missing, verify `#[unsafe(no_mangle)] extern "C"` exports and the calculator package registration in Rust.',
        )
      : pass('Rust ABI', 'rust.archive.symbols', 'Rust archive exposes the required FFI and fast-path symbols'),
    absentArchitectures.length
      ? fail(
          'Rust ABI',
          'rust.archive.architectures',
          'Rust archive does not cover the default simulator architectures',
          `missing: ${absentArchitectures.join(', ')}`,
          'Install both simulator Rust targets, then run `bun run rust:ios` without RUSTRA_IOS_TARGET so the build script creates a universal archive.',
        )
      : pass('Rust ABI', 'rust.archive.architectures', 'Rust archive is universal for iOS Simulator'),
  ];
}

export function analyzeInstalledBinary({ binaryMtimeMs, newestInputMtimeMs, newestInputPath, symbols }) {
  const absentSymbols = missingSymbols(REQUIRED_INSTALLED_SYMBOLS, symbols);
  return [
    binaryMtimeMs < newestInputMtimeMs
      ? fail(
          'Runtime',
          'ios.app.freshness',
          'Installed app does not contain the current Rustra worktree',
          `newer input: ${newestInputPath ?? 'unknown build input'}`,
          'Run `bun run ios -- --configuration Release`. A current archive on disk does not update an already installed app.',
        )
      : pass('Runtime', 'ios.app.freshness', 'Installed app binary is newer than the current Rust archive'),
    absentSymbols.length
      ? fail(
          'Runtime ABI',
          'ios.app.symbols',
          'Installed app binary is missing required Rust fast-path symbols',
          `missing: ${absentSymbols.join(', ')}`,
          'Run `bun run rust:ios`, then `bun run ios -- --configuration Release`. If symbols remain missing, inspect Pod force-load settings and Rust `extern "C"` exports.',
        )
      : pass('Runtime ABI', 'ios.app.symbols', 'Installed app binary links the required Rust fast-path symbols'),
  ];
}

export function analyzeAutolinking({ reactNativeConfig, podfileLock }) {
  let dependency;
  try {
    dependency = JSON.parse(reactNativeConfig).dependencies?.['@rustra/generated-react-native'];
  } catch {
    // The failure below carries the repair command.
  }
  const configsValid = Boolean(
    dependency?.platforms?.ios?.podspecPath?.endsWith('/RustraBridge.podspec') &&
      dependency?.platforms?.android?.sourceDir?.endsWith('/android'),
  );
  const missingPods = ['RustraBridge', 'RustraCalculator', 'NitroBench'].filter(
    (pod) => !new RegExp(`^  - ${pod} \\(`, 'm').test(podfileLock),
  );
  return [
    configsValid
      ? pass('RN/Pod', 'native.autolinking.config', 'React Native autolinking finds Rustra on iOS and Android')
      : fail(
          'RN/Pod',
          'native.autolinking.config',
          'React Native autolinking does not expose Rustra on both platforms',
          'Expected @rustra/generated-react-native with an iOS Podspec and Android sourceDir.',
          'Run `bun run codegen`, `bun install`, then `bunx --bun react-native config`.',
        ),
    missingPods.length
      ? fail(
        'RN/Pod',
          'ios.pods.locked',
          'Required iOS Pods are missing from Podfile.lock',
          `missing: ${missingPods.join(', ')}`,
          'Run `bun install`, then `bunx pod-install ios`. Rebuild the native app; Metro reload is not sufficient.',
        )
      : pass('RN/Pod', 'ios.pods.locked', 'Rustra, Swift FFI, and Nitro comparison Pods are installed'),
  ];
}

export function formatDoctorReport(report) {
  const lines = [`rustra doctor: ${report.app}`, `root: ${report.appRoot}`, ''];
  for (const item of report.checks) {
    lines.push(`${item.status.toUpperCase()} [${item.layer}] ${item.summary}`);
    if (item.details) lines.push(`  detail: ${item.details}`);
    if (item.fix) lines.push(`  fix: ${item.fix}`);
  }
  lines.push(
    '',
    `summary: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failures`,
    'doctor is read-only; it does not rebuild, install Pods, or launch the app.',
  );
  return lines.join('\n');
}
