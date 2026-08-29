import { constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RUSTRA_MSRV,
  type DoctorCheck,
  type DoctorConfig,
  type DoctorOptions,
  type DoctorRunner,
} from './doctor-types.js';
import { isVersionAtLeast, parseRustVersion } from './doctor-types.js';
import {
  addAndroidChecks,
  canAccess,
  check,
  commandCheck,
  conditionalCheck,
  getCargoMetadata,
  nearestExistingParent,
  resolveManifest,
  safeResolve,
  selectGenerator,
} from './doctor-support.js';

export function collectBaseChecks(options: DoctorOptions, runner: DoctorRunner): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const rustc = runner('rustc', ['--version']);
  const version = parseRustVersion(`${rustc.stdout}\n${rustc.stderr}`);
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
  checks.push(
    conditionalCheck(
      'rustc.msrv',
      true,
      Boolean(rustc.ok && version && isVersionAtLeast(version, RUSTRA_MSRV)),
      version ? `Rust ${version.join('.')} satisfies MSRV 1.88` : 'Rust satisfies MSRV 1.88',
      `Rust 1.88 or newer is required${version ? ` (found ${version.join('.')})` : ''}`,
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
  const compiler = platform === 'win32' ? 'cl' : 'c++';
  checks.push(
    commandCheck(
      runner,
      compiler,
      platform === 'win32' ? ['/Bv'] : ['--version'],
      'toolchain.cpp',
      'C/C++ compiler',
      [
        platform === 'win32'
          ? 'Open a Visual Studio Developer Command Prompt or install the MSVC C++ workload'
          : 'Install the platform C++ compiler (Xcode Command Line Tools or build-essential)',
      ],
    ),
  );
  checks.push(
    commandCheck(runner, 'cmake', ['--version'], 'toolchain.cmake', 'CMake', [
      'Install CMake and ensure it is on PATH',
    ]),
  );
  return checks;
}

export function collectConfigChecks(
  options: DoctorOptions,
  runner: DoctorRunner,
  configPath: string,
  config: DoctorConfig,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const root = dirname(configPath);
  const cargo = runner('cargo', ['--version']);
  const manifest = resolveManifest(root, config);
  checks.push(
    conditionalCheck(
      'codegen.rust_manifest',
      true,
      Boolean(manifest),
      `Cargo manifest: ${manifest ?? ''}`,
      'Could not find Cargo.toml for codegen',
      undefined,
      ['Set codegen.rustManifest in rustra.json'],
    ),
  );
  if (manifest && existsSync(manifest) && cargo.ok) {
    const metadata = getCargoMetadata(runner, manifest);
    if (metadata.metadata) {
      const selected = selectGenerator(
        metadata.metadata,
        manifest,
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
    } else
      checks.push(
        check(
          'codegen.rust_binary',
          'fail',
          true,
          'Cargo metadata could not inspect the generator',
          metadata.error,
          ['Run cargo metadata manually and fix the Cargo manifest'],
        ),
      );
  } else
    checks.push(
      check(
        'codegen.rust_binary',
        'skip',
        true,
        'Skipped Cargo binary selection because the manifest or cargo is unavailable',
      ),
    );

  const schemaPath = safeResolve(root, config.schema);
  const outputPath = safeResolve(root, config.output);
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
  if (outputPath && existsSync(outputPath))
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
  else if (outputPath) {
    const parent = nearestExistingParent(dirname(outputPath));
    const writable = parent !== undefined && canAccess(parent, constants.W_OK);
    checks.push(
      check(
        'codegen.output_directory',
        'warn',
        false,
        writable
          ? `Generated output directory will be created: ${outputPath}`
          : `Generated output directory may not be creatable: ${outputPath}`,
        writable
          ? undefined
          : `Nearest existing parent is not writable: ${parent ?? dirname(outputPath)}`,
        ['Create the output directory or grant write permission'],
      ),
    );
  }
  const platform = options.platform ?? process.platform;
  if (config.reactNative) {
    checks.push(
      platform === 'darwin'
        ? check('rn.ios.platform', 'pass', true, 'macOS is available for React Native iOS builds')
        : check('rn.ios.platform', 'skip', false, 'React Native iOS build requires macOS'),
    );
    if (platform === 'darwin') {
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
    }
    addAndroidChecks(checks, runner, options.env ?? process.env);
  }
  if (config.tauri) {
    const command =
      platform === 'darwin' ? 'xcodebuild' : platform === 'win32' ? 'cl' : 'pkg-config';
    const args =
      command === 'xcodebuild' ? ['-version'] : command === 'pkg-config' ? ['--version'] : [];
    checks.push(
      commandCheck(runner, command, args, 'tauri.platform_tools', `Tauri ${platform} build tools`, [
        'Install the native build tools required by the current platform',
      ]),
    );
  }
  return checks;
}
