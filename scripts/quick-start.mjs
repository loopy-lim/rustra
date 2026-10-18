import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { collectBenchmarkSource, benchmarkArtifact } from './host-benchmark-provenance.mjs';
import { mutateScaffoldProject } from './onboarding-gate.mjs';
import {
  captureProducerArtifact,
  onboardingPackageArtifact,
  onboardingReceipt,
  openRawLogDirectory,
  openReceiptTarget,
  scaffoldNativeArtifactPath,
  stampProducerStability,
  writeOnboardingReceipt,
} from './onboarding-receipt.mjs';

export function parseQuickStartArgs(args) {
  const options = {
    host: 'node',
    manager: 'bun',
    clean: false,
    cold: false,
    measure: false,
    output: null,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--clean') options.clean = true;
    else if (arg === '--cold') options.cold = true;
    else if (arg === '--measure') options.measure = true;
    else if (['--host', '--package-manager', '--output'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      options[arg === '--host' ? 'host' : arg === '--output' ? 'output' : 'manager'] = value;
    } else throw new Error(`unknown quick-start argument: ${arg}`);
  }
  if (!['node', 'bun'].includes(options.host)) throw new Error('--host must be node or bun');
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(options.manager))
    throw new Error('--package-manager must be bun, npm, pnpm or yarn');
  return options;
}

/** A local-source journey. Package managers install real dependencies, without certifying a release. */
export function runQuickStart(
  options,
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const repo = realpathSync(repoRoot);
  const output = openReceiptTarget({
    requested: options.output,
    defaultName: `quick-${options.manager}-${Date.now()}-${process.pid}.json`,
    repo,
  });
  mkdirSync(join(repo, 'target'), { recursive: true });
  const root = mkdtempSync(join(repo, 'target', `quick-start-${options.host}-${options.manager}-`));
  const app = join(root, 'app');
  const cli = join(repo, 'packages/cli/dist/index.js');
  const targetDir = options.cold
    ? join(root, 'cargo-target')
    : join(repo, 'target/quick-start-shared');
  const cache = {
    cargoTarget: options.cold
      ? 'fresh-project-target'
      : existsSync(targetDir)
        ? 'shared-existing'
        : 'shared-new',
    cargoTargetDir: targetDir,
    dependencyDownloads: 'shared-cache-not-cleared',
  };
  const rawLogDirectory = openRawLogDirectory(output);
  const env = {
    ...process.env,
    // An inherited target must not turn an explicitly cold journey into a warm build.
    CARGO_TARGET_DIR: targetDir,
    BUN_INSTALL_CACHE_DIR: join(repo, 'target/quick-start-bun-cache'),
    npm_config_cache: join(repo, 'target/quick-start-npm-cache'),
    npm_config_store_dir: join(repo, 'target/quick-start-pnpm-store'),
    YARN_CACHE_FOLDER: join(repo, 'target/quick-start-yarn-cache'),
    TMPDIR: root,
  };
  // Manager shims inspect the nearest package.json even for --version. The repo
  // itself pins Bun, so probe outside it before writing the consumer's own pin.
  const version = spawnSync(options.manager, ['--version'], {
    cwd: tmpdir(),
    env,
    encoding: 'utf8',
  });
  if (version.error || version.status !== 0)
    throw new Error(
      `${options.manager} is not available: ${version.error?.message ?? version.stderr}`,
    );
  const managerVersion = version.stdout.trim();
  const sourceBefore = collectBenchmarkSource(repo);
  const producerBefore = captureProducerArtifact(repo);
  const started = performance.now();
  const report = { ok: false, steps: [], cache };
  const artifacts = [];
  const record = (name, action) => {
    const before = performance.now();
    let ok = false;
    try {
      const value = action();
      ok = true;
      return value;
    } finally {
      const after = performance.now();
      report.steps.push({
        name,
        ok,
        durationMs: after - before,
        startedAfterMs: before - started,
        completedAfterMs: after - started,
      });
    }
  };
  const run = (name, command, args, cwd, expectedOutput) =>
    record(name, () => {
      const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      writeFileSync(
        join(rawLogDirectory, `${name}.log`),
        `${JSON.stringify({ command, args, cwd })}\n${text}`,
      );
      if (text) console.log(text.trimEnd());
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${name}: ${command} failed (${result.signal ?? result.status}). Project kept at ${app}`,
        );
      if (expectedOutput && !text.includes(expectedOutput))
        throw new Error(
          `${name}: expected Rust result ${JSON.stringify(expectedOutput)} was not observed`,
        );
      return text;
    });
  const snapshot = (phase) =>
    artifacts.push({
      phase,
      files: [
        'Cargo.lock',
        'package.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'package-lock.json',
        'bun.lock',
        'src/lib.rs',
        'src/index.ts',
        'src/generated/contract.ts',
      ]
        .map((path) => benchmarkArtifact(app, path))
        .filter(Boolean),
      native: benchmarkArtifact(targetDir, scaffoldNativeArtifactPath(options.host)),
      installedPackages: ['cli', 'types', options.host].map((name) =>
        onboardingPackageArtifact(join(app, 'node_modules/@rustra', name)),
      ),
    });
  try {
    run('init', process.execPath, [cli, 'init', app, '--host', options.host], repo);
    record('source-setup', () => {
      const manifestPath = join(app, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.packageManager = `${options.manager}@${managerVersion}`;
      for (const [section, names] of [
        ['dependencies', ['types', options.host]],
        ['devDependencies', ['cli']],
      ]) {
        for (const name of names)
          manifest[section][`@rustra/${name}`] = `file:${join(repo, 'packages', name)}`;
      }
      // The transitive types dependency must resolve to the same candidate under every manager.
      const override = { '@rustra/types': `file:${join(repo, 'packages/types')}` };
      if (options.manager === 'pnpm') manifest.pnpm = { overrides: override };
      else if (options.manager === 'yarn') manifest.resolutions = override;
      else manifest.overrides = override;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      mkdirSync(join(app, '.cargo'), { recursive: true });
      writeFileSync(
        join(app, '.cargo/config.toml'),
        `[build]\ntarget-dir = ${JSON.stringify(targetDir)}\n\n[patch.crates-io]\n${['rustra', 'rustra-macros', 'rustra-naming'].map((name) => `${name} = { path = ${JSON.stringify(join(repo, 'crates', name))} }`).join('\n')}\n`,
      );
    });
    const manifestBefore = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    const configBefore = readFileSync(join(app, 'rustra.json'), 'utf8');
    run(
      'first-call',
      process.execPath,
      [cli, 'setup', '--config', join(app, 'rustra.json'), '--run'],
      app,
      'hello from TypeScript',
    );
    snapshot('first-call');
    // The second start must resolve the candidate CLI installed by the selected package manager.
    run('warm-start', options.manager, ['run', 'start'], app, 'hello from TypeScript');
    snapshot('warm-start');
    if (options.measure) {
      const appPath = join(app, 'src/index.ts');
      const libPath = join(app, 'src/lib.rs');
      const originalApp = readFileSync(appPath, 'utf8');
      const originalLib = readFileSync(libPath, 'utf8');
      record('javascript-change', () =>
        writeFileSync(
          appPath,
          originalApp.replace('hello from TypeScript', 'javascript iteration'),
        ),
      );
      run('javascript-verify', options.manager, ['run', 'demo'], app, 'javascript iteration');
      snapshot('javascript-change');
      writeFileSync(appPath, originalApp);
      record('implementation-change', () =>
        writeFileSync(
          libPath,
          originalLib.replace('message: input.message', 'message: input.message.to_uppercase()'),
        ),
      );
      run(
        'implementation-verify',
        process.execPath,
        [cli, 'setup', '--config', join(app, 'rustra.json'), '--skip-install', '--run'],
        app,
        'HELLO FROM TYPESCRIPT',
      );
      snapshot('implementation-change');
      // Start the schema-change fixture from the original handler; setup must rebuild it.
      writeFileSync(libPath, originalLib);
      record('mutate', () => {
        mutateScaffoldProject(app);
        writeFileSync(
          appPath,
          readFileSync(appPath, 'utf8').replace(
            'console.log(result.message)',
            'console.log(JSON.stringify(result))',
          ),
        );
      });
      run(
        'verify',
        process.execPath,
        [cli, 'setup', '--config', join(app, 'rustra.json'), '--skip-install', '--run'],
        app,
        '"repeat":3',
      );
      snapshot('contract-change');
    }
    const manifestAfter = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    if (
      JSON.stringify(manifestBefore.scripts) !== JSON.stringify(manifestAfter.scripts) ||
      configBefore !== readFileSync(join(app, 'rustra.json'), 'utf8')
    )
      throw new Error('setup changed user scripts or rustra.json');
    report.ok = true;
    if (!options.clean)
      console.log(
        `\nYour ${options.host} example is ready: ${app}\nEdit src/lib.rs, then run ${options.manager} run start in that directory.`,
      );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const receipt = onboardingReceipt({
      report,
      sourceBefore,
      sourceAfter: collectBenchmarkSource(repo),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        packageManager: options.manager,
        packageManagerVersion: managerVersion,
        scriptsRuntime: 'bun',
        host: options.host,
        sdkInstallationIncluded: false,
        cargoOffline: process.env.CARGO_NET_OFFLINE === 'true',
      },
      consumption: 'source-injected',
      rawLogDirectory,
    });
    receipt.artifacts = artifacts;
    receipt.producerBefore = producerBefore;
    stampProducerStability(repo, receipt);
    receipt.projectDir = app;
    writeOnboardingReceipt(output, receipt);
    console.log(`[quick-start] receipt: ${output}`);
    if (options.clean && report.ok) rmSync(root, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  runQuickStart(parseQuickStartArgs(process.argv.slice(2)));
