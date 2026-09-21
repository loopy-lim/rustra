#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, version as osVersion, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutateScaffoldProject } from './onboarding-gate.mjs';
import {
  pinCargoVersions,
  pinOriginalScaffold,
  prepareRegistryFixture,
} from './registry-consumer/fixture.mjs';
import {
  assertCargoProvenance,
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  generatedFiles,
  hashFiles,
  readJson,
  sha256File,
  validateVersionManifest,
  writeJson,
} from './registry-consumer/provenance.mjs';
import { errorDetails, runOrderedSteps, sanitizeStepName } from './registry-consumer/runner.mjs';

export {
  assertCargoProvenance,
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  prepareRegistryFixture,
  runOrderedSteps,
  validateVersionManifest,
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSIONS_PATH = fileURLToPath(new URL('./registry-consumer/versions.json', import.meta.url));
const PROJECT_NAME = 'registry-consumer';
const RESULT_MARKER = '__RUSTRA_REGISTRY_RESULT__';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseCliArgs(argv) {
  let outputPath;
  let outputCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--output') throw new Error(`unknown option: ${option}`);
    outputCount += 1;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--output requires an absolute path');
    outputPath = value;
    index += 1;
  }
  if (outputCount !== 1) throw new Error('--output must be provided exactly once');
  if (!isAbsolute(outputPath)) throw new Error('--output must be an absolute path');
  return { outputPath: resolve(outputPath) };
}

function recoverOutputPath(argv) {
  const indexes = argv.flatMap((value, index) => (value === '--output' ? [index] : []));
  if (indexes.length !== 1) return null;
  const value = argv[indexes[0] + 1];
  return value && !value.startsWith('--') && isAbsolute(value) ? resolve(value) : null;
}

function attachFailure(error, context, step) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.step = step ?? failure.step;
  failure.steps = context.steps;
  failure.scratchRoot = context.scratchRoot;
  throw failure;
}

async function commandStep(context, name, cwd, argv, extraEnv = {}) {
  const ordinal = context.steps.length + 1;
  const stepLogDir = context.logDir;
  const result = await runOrderedSteps({
    logDir: stepLogDir,
    steps: [
      {
        name: `${String(ordinal).padStart(3, '0')}-${name}`,
        command: { cwd, argv, env: { ...context.env, ...extraEnv } },
      },
    ],
  });
  const report = result.steps[0];
  // runOrderedSteps gets one step at a time; rename its path so global ordinal remains unique.
  const desiredLog = join(
    stepLogDir,
    `${String(ordinal).padStart(3, '0')}-${sanitizeStepName(name)}.log`,
  );
  if (report.rawLogPath !== desiredLog) {
    writeFileSync(desiredLog, readFileSync(report.rawLogPath));
    if (report.rawLogPath !== desiredLog) rmSync(report.rawLogPath, { force: true });
    report.rawLogPath = desiredLog;
    if (result.error) result.error.rawLogPath = desiredLog;
  }
  const output = { stdout: report.stdout ?? '', stderr: report.stderr ?? '' };
  delete report.stdout;
  delete report.stderr;
  report.name = name;
  context.steps.push(report);
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    error.step = { name, rawLogPath: report.rawLogPath };
    attachFailure(error, context);
  }
  return output;
}

function internalStep(context, name, operation) {
  const ordinal = context.steps.length + 1;
  const startedAt = new Date();
  const rawLogPath = join(
    context.logDir,
    `${String(ordinal).padStart(3, '0')}-${sanitizeStepName(name)}.log`,
  );
  try {
    const value = operation();
    writeFileSync(rawLogPath, `step: ${name}\nstatus: ok\n`);
    context.steps.push({
      name,
      ok: true,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: 0,
      signal: null,
      rawLogPath,
    });
    return value;
  } catch (error) {
    writeFileSync(rawLogPath, `${JSON.stringify(errorDetails(error), null, 2)}\n`);
    context.steps.push({
      name,
      ok: false,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: null,
      signal: null,
      rawLogPath,
    });
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.step = { name, rawLogPath };
    attachFailure(failure, context);
  }
}

function parseProbeOutput(stdout, label) {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`${label} did not emit ${RESULT_MARKER}`);
  try {
    return JSON.parse(line.slice(RESULT_MARKER.length));
  } catch (error) {
    throw new Error(`${label} emitted malformed result JSON: ${errorText(error)}`);
  }
}

function contractHash(projectDir) {
  const text = readFileSync(join(projectDir, 'src', 'generated', 'contract.ts'), 'utf8');
  const match = text.match(/GENERATED_CONTRACT_HASH\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('generated contract.ts does not contain GENERATED_CONTRACT_HASH');
  return match[1];
}

function nativeArtifactPaths(context) {
  const executable = join(
    context.targetDir,
    'debug',
    process.platform === 'win32' ? 'rustra-app.exe' : 'rustra-app',
  );
  const libraryBase =
    process.platform === 'win32'
      ? 'rustra_app.dll'
      : process.platform === 'darwin'
        ? 'librustra_app.dylib'
        : 'librustra_app.so';
  const library = join(context.targetDir, 'debug', libraryBase);
  for (const path of [executable, library]) {
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error(`native artifact missing: ${path}`);
  }
  return { executable, library };
}

function snapshotPhaseEvidence(context, phase) {
  const snapshotRoot = join(context.evidenceDir, phase);
  mkdirSync(snapshotRoot, { recursive: true });
  for (const relativePath of [
    'Cargo.lock',
    'Cargo.toml',
    'package-lock.json',
    'package.json',
    'rustra.json',
  ]) {
    cpSync(join(context.projectDir, relativePath), join(snapshotRoot, relativePath));
  }
  cpSync(join(context.projectDir, 'src', 'generated'), join(snapshotRoot, 'src', 'generated'), {
    recursive: true,
  });
  const files = [
    'Cargo.lock',
    'Cargo.toml',
    'package-lock.json',
    'package.json',
    'rustra.json',
    ...generatedFiles(snapshotRoot),
  ];
  return { root: snapshotRoot, files: hashFiles(snapshotRoot, files) };
}

async function runnerIdentity(context) {
  const head = await commandStep(context, 'runner-git-head', context.repoRoot, [
    'git',
    'rev-parse',
    'HEAD',
  ]);
  const status = await commandStep(context, 'runner-git-status', context.repoRoot, [
    'git',
    'status',
    '--porcelain',
  ]);
  const sources = [
    SCRIPT_PATH,
    fileURLToPath(new URL('./onboarding-gate.mjs', import.meta.url)),
    fileURLToPath(new URL('./registry-consumer/fixture.mjs', import.meta.url)),
    fileURLToPath(new URL('./registry-consumer/provenance.mjs', import.meta.url)),
    fileURLToPath(new URL('./registry-consumer/runner.mjs', import.meta.url)),
    VERSIONS_PATH,
  ];
  const snapshotRoot = join(context.evidenceDir, 'runner');
  mkdirSync(snapshotRoot, { recursive: true });
  const sourceFiles = {};
  for (const path of sources) {
    const relativePath = path.slice(context.repoRoot.length + 1);
    const retainedPath = join(snapshotRoot, relativePath);
    mkdirSync(dirname(retainedPath), { recursive: true });
    cpSync(path, retainedPath);
    sourceFiles[relativePath] = { retainedPath, sha256: sha256File(retainedPath) };
  }
  return {
    gitHead: head.stdout.trim(),
    gitDirty: status.stdout.length > 0,
    sourceFiles,
  };
}

function phaseEvidence(context, phase, expectedRust, node, bun) {
  return internalStep(context, `${phase}-provenance`, () => {
    assertNoConsumerContamination(context.projectDir, { expectedNpm: context.versions.npm });
    const npm = assertExactNpmProvenance(context.projectDir, context.versions.npm);
    const metadata = JSON.parse(context.lastMetadata);
    const cargo = assertCargoProvenance({
      metadata,
      lockText: readFileSync(join(context.projectDir, 'Cargo.lock'), 'utf8'),
      expected: expectedRust,
      consumerManifestPath: join(context.projectDir, 'Cargo.toml'),
    });
    const artifacts = nativeArtifactPaths(context);
    const snapshot = snapshotPhaseEvidence(context, phase);
    return {
      phase,
      transition: phase === 'baseline' ? 'initial-install' : 'rust-only-patch',
      expectedVersions: { npm: context.versions.npm, rust: expectedRust },
      installed: { npm, cargo },
      locks: {
        npm: {
          path: join(snapshot.root, 'package-lock.json'),
          sha256: snapshot.files['package-lock.json'],
        },
        cargo: {
          path: join(snapshot.root, 'Cargo.lock'),
          sha256: snapshot.files['Cargo.lock'],
        },
      },
      generated: {
        contractHash: contractHash(context.projectDir),
        root: join(snapshot.root, 'src', 'generated'),
        files: Object.fromEntries(
          Object.entries(snapshot.files).filter(([path]) => path.startsWith('src/generated/')),
        ),
      },
      evidenceSnapshot: snapshot,
      nativeArtifacts: {
        nodeExecutable: {
          originalPath: artifacts.executable,
          sha256: sha256File(artifacts.executable),
          retainedAfterSuccess: false,
        },
        bunLibrary: {
          originalPath: artifacts.library,
          sha256: sha256File(artifacts.library),
          retainedAfterSuccess: false,
        },
      },
      hosts: { node, bun },
    };
  });
}

export function assertPhaseOutput({ phase, output, baseline }) {
  for (const host of ['node', 'bun']) {
    if (output[host]?.message === undefined)
      throw new Error(`${phase} ${host} output is missing message`);
    if (output[host]?.repeat !== 3)
      throw new Error(`${phase} ${host} output is missing returned repeat=3`);
  }
  if (phase === 'rollback') {
    if (output.contractHash !== baseline.contractHash)
      throw new Error(
        `rollback contract hash ${output.contractHash} does not match baseline ${baseline.contractHash}`,
      );
    for (const host of ['node', 'bun']) {
      if (JSON.stringify(output[host]) !== JSON.stringify(baseline[host]))
        throw new Error(`rollback ${host} output does not match baseline`);
    }
  }
  return { ok: true };
}

async function collectCargoMetadata(context, phase) {
  const result = await commandStep(context, `${phase}-cargo-metadata`, context.projectDir, [
    'cargo',
    'metadata',
    '--format-version',
    '1',
    '--locked',
  ]);
  context.lastMetadata = result.stdout;
}

async function runHostProbes(context, phase, mutated) {
  const artifacts = internalStep(context, `${phase}-native-artifact-verification`, () =>
    nativeArtifactPaths(context),
  );
  const extra = mutated ? { RUSTRA_EXPECT_REPEAT: '3' } : {};
  const nodeResult = await commandStep(
    context,
    `${phase}-bundle-generated-node-probe`,
    context.projectDir,
    ['bun', 'build', 'src/node-probe.ts', '--target=node', '--outfile=.registry-node-probe.mjs'],
  );
  void nodeResult;
  const nodeInvoke = await commandStep(
    context,
    `${phase}-node-stdio`,
    context.projectDir,
    [process.execPath, '.registry-node-probe.mjs'],
    { ...extra, RUSTRA_NODE_BINARY: artifacts.executable },
  );
  const bunResult = await commandStep(
    context,
    `${phase}-bun-ffi`,
    context.projectDir,
    ['bun', 'run', 'src/bun-probe.ts'],
    { ...extra, RUSTRA_BUN_LIBRARY: artifacts.library },
  );
  return internalStep(context, `${phase}-host-output-verification`, () => {
    const node = parseProbeOutput(nodeInvoke.stdout, `${phase} Node probe`);
    const bun = parseProbeOutput(bunResult.stdout, `${phase} Bun probe`);
    if (node.host !== 'node' || node.adapter !== '@rustra/node' || node.transport !== 'stdio')
      throw new Error(`${phase} Node probe reported the wrong host/adapter`);
    if (bun.host !== 'bun' || bun.adapter !== '@rustra/bun' || bun.transport !== 'ffi')
      throw new Error(`${phase} Bun probe reported the wrong host/adapter`);
    return { node, bun };
  });
}

async function runRustPhase(context, phase, expectedRust, { check = false } = {}) {
  internalStep(context, `${phase}-pin-rust`, () =>
    pinCargoVersions(context.projectDir, expectedRust),
  );
  internalStep(context, `${phase}-contamination-prebuild`, () =>
    assertNoConsumerContamination(context.projectDir, { expectedNpm: context.versions.npm }),
  );
  await commandStep(context, `${phase}-build`, context.projectDir, ['cargo', 'build']);
  await commandStep(context, `${phase}-codegen`, context.projectDir, [
    process.execPath,
    context.projectCli,
    'codegen',
    '--config',
    'rustra.json',
  ]);
  await commandStep(context, `${phase}-rebuild`, context.projectDir, ['cargo', 'build']);
  if (check)
    await commandStep(context, `${phase}-codegen-check`, context.projectDir, [
      process.execPath,
      context.projectCli,
      'codegen',
      '--config',
      'rustra.json',
      '--check',
    ]);
  await collectCargoMetadata(context, phase);
}

async function environmentEvidence(context) {
  const commands = [
    ['node', process.execPath, ['--version']],
    ['npm', 'npm', ['--version']],
    ['bun', 'bun', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['rustc', 'rustc', ['--version']],
  ];
  const environment = {
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    osVersion: osVersion(),
  };
  for (const [name, executable, args] of commands) {
    const result = await commandStep(context, `environment-${name}`, context.scratchRoot, [
      executable,
      ...args,
    ]);
    environment[name] = result.stdout.trim();
  }
  if (process.platform === 'darwin') {
    const swVers = await commandStep(context, 'environment-sw-vers', context.scratchRoot, [
      'sw_vers',
      '-productVersion',
    ]);
    environment.productVersion = swVers.stdout.trim();
  }
  return environment;
}

async function executeRegistryCycle({ logDir }) {
  const versions = validateVersionManifest(readJson(VERSIONS_PATH));
  const scratchRoot = mkdtempSync(join(tmpdir(), 'rustra-registry-consumer-'));
  const projectDir = join(scratchRoot, PROJECT_NAME);
  const targetDir = join(scratchRoot, 'cargo-target');
  const isolatedTmp = join(scratchRoot, 'tmp');
  mkdirSync(isolatedTmp, { recursive: true });
  const context = {
    logDir,
    evidenceDir: join(dirname(logDir), 'registry-consumer-evidence'),
    repoRoot: resolve(dirname(SCRIPT_PATH), '..'),
    scratchRoot,
    projectDir,
    targetDir,
    versions,
    steps: [],
    env: {
      ...process.env,
      TMPDIR: isolatedTmp,
      CARGO_HOME: join(scratchRoot, 'cargo-home'),
      CARGO_TARGET_DIR: targetDir,
      BUN_INSTALL_CACHE_DIR: join(scratchRoot, 'bun-cache'),
      npm_config_cache: join(scratchRoot, 'npm-cache'),
      CI: process.env.CI ?? 'true',
    },
  };
  try {
    const environment = await environmentEvidence(context);
    const runner = await runnerIdentity(context);
    internalStep(context, 'prepare-bootstrap-manifest', () => {
      writeJson(join(scratchRoot, 'package.json'), {
        name: 'rustra-registry-bootstrap',
        private: true,
        dependencies: { '@rustra/cli': versions.npm['@rustra/cli'] },
      });
      assertNoConsumerContamination(scratchRoot);
    });
    await commandStep(context, 'install-published-cli', scratchRoot, [
      'npm',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const bootstrapNpm = internalStep(context, 'verify-published-cli-source', () =>
      assertExactNpmProvenance(scratchRoot, { '@rustra/cli': versions.npm['@rustra/cli'] }),
    );
    const bootstrapCli = join(scratchRoot, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    await commandStep(context, 'published-cli-init', scratchRoot, [
      process.execPath,
      bootstrapCli,
      'init',
      PROJECT_NAME,
    ]);
    internalStep(context, 'pin-original-scaffold', () => pinOriginalScaffold(projectDir, versions));
    internalStep(context, 'verify-clean-fixture-before-install', () =>
      assertNoConsumerContamination(projectDir, { expectedNpm: versions.npm }),
    );
    const originalInstallInputs = [
      `@rustra/cli@${versions.npm['@rustra/cli']}`,
      `@rustra/types@${versions.npm['@rustra/types']}`,
      `@rustra/node@${versions.npm['@rustra/node']}`,
    ];
    await commandStep(context, 'resolve-original-exact-npm-lock', projectDir, [
      'npm',
      'install',
      '--package-lock-only',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...originalInstallInputs,
    ]);
    await commandStep(context, 'install-original-frozen-npm-lock', projectDir, [
      'npm',
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const originalNpm = internalStep(context, 'verify-original-exact-npm-sources', () => {
      assertNoConsumerContamination(projectDir, { expectedNpm: versions.npm });
      return assertExactNpmProvenance(projectDir, {
        '@rustra/cli': versions.npm['@rustra/cli'],
        '@rustra/types': versions.npm['@rustra/types'],
        '@rustra/node': versions.npm['@rustra/node'],
      });
    });
    context.projectCli = join(projectDir, 'node_modules', '@rustra', 'cli', 'dist', 'index.js');
    await commandStep(context, 'baseline-doctor', projectDir, [
      process.execPath,
      context.projectCli,
      'doctor',
      '--config',
      'rustra.json',
    ]);
    await runRustPhase(context, 'baseline-initial', versions.phases.baseline, { check: true });
    const originalDemo = await commandStep(context, 'baseline-original-demo', projectDir, [
      'bun',
      'run',
      'demo',
    ]);
    internalStep(context, 'baseline-original-demo-output-verification', () => {
      if (!originalDemo.stdout.includes('hello from TypeScript'))
        throw new Error('original scaffold demo did not print hello from TypeScript');
    });
    const originalScaffoldEvidence = internalStep(context, 'baseline-original-provenance', () => ({
      installed: {
        npm: originalNpm,
        cargo: assertCargoProvenance({
          metadata: JSON.parse(context.lastMetadata),
          lockText: readFileSync(join(projectDir, 'Cargo.lock'), 'utf8'),
          expected: versions.phases.baseline,
          consumerManifestPath: join(projectDir, 'Cargo.toml'),
        }),
      },
      contractHash: contractHash(projectDir),
      evidenceSnapshot: snapshotPhaseEvidence(context, 'baseline-original'),
      demo: {
        jsRuntime: 'bun',
        adapter: '@rustra/node',
        transport: 'stdio',
        classification: 'original generated demo; not Bun FFI evidence',
      },
    }));

    internalStep(context, 'extend-public-host-fixture', () =>
      prepareRegistryFixture(projectDir, versions),
    );
    internalStep(context, 'verify-extended-fixture-before-install', () =>
      assertNoConsumerContamination(projectDir, { expectedNpm: versions.npm }),
    );
    const extendedInstallInputs = [
      ...originalInstallInputs,
      `@rustra/bun@${versions.npm['@rustra/bun']}`,
    ];
    await commandStep(context, 'resolve-extended-exact-npm-lock', projectDir, [
      'npm',
      'install',
      '--package-lock-only',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...extendedInstallInputs,
    ]);
    await commandStep(context, 'install-extended-frozen-npm-lock', projectDir, [
      'npm',
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const npmInstalled = internalStep(context, 'verify-extended-exact-npm-sources', () => {
      assertNoConsumerContamination(projectDir, { expectedNpm: versions.npm });
      return assertExactNpmProvenance(projectDir, versions.npm);
    });
    await runRustPhase(context, 'baseline-extended', versions.phases.baseline, { check: true });
    const initialHosts = await runHostProbes(context, 'baseline-extended', false);

    internalStep(context, 'baseline-mutate-contract', () => mutateScaffoldProject(projectDir));
    await runRustPhase(context, 'baseline-mutated', versions.phases.baseline, { check: true });
    const baselineHosts = await runHostProbes(context, 'baseline-mutated', true);
    const baseline = phaseEvidence(
      context,
      'baseline',
      versions.phases.baseline,
      baselineHosts.node,
      baselineHosts.bun,
    );
    const baselineOutput = {
      contractHash: baseline.generated.contractHash,
      node: baselineHosts.node.result,
      bun: baselineHosts.bun.result,
    };
    internalStep(context, 'baseline-output-verification', () =>
      assertPhaseOutput({ phase: 'baseline', output: baselineOutput, baseline: baselineOutput }),
    );

    await runRustPhase(context, 'candidate', versions.phases.candidate, { check: true });
    const candidateHosts = await runHostProbes(context, 'candidate', true);
    const candidate = phaseEvidence(
      context,
      'candidate',
      versions.phases.candidate,
      candidateHosts.node,
      candidateHosts.bun,
    );
    internalStep(context, 'candidate-output-verification', () =>
      assertPhaseOutput({
        phase: 'candidate',
        output: {
          contractHash: candidate.generated.contractHash,
          node: candidateHosts.node.result,
          bun: candidateHosts.bun.result,
        },
        baseline: baselineOutput,
      }),
    );

    await runRustPhase(context, 'rollback', versions.phases.rollback, { check: true });
    const rollbackHosts = await runHostProbes(context, 'rollback', true);
    const rollback = phaseEvidence(
      context,
      'rollback',
      versions.phases.rollback,
      rollbackHosts.node,
      rollbackHosts.bun,
    );
    internalStep(context, 'rollback-output-verification', () =>
      assertPhaseOutput({
        phase: 'rollback',
        output: {
          contractHash: rollback.generated.contractHash,
          node: rollbackHosts.node.result,
          bun: rollbackHosts.bun.result,
        },
        baseline: baselineOutput,
      }),
    );

    return {
      configuration: { manifestPath: VERSIONS_PATH, versions },
      environment,
      runner,
      scratchRoot,
      projectDir,
      steps: context.steps,
      bootstrapNpm,
      npmInstalled,
      pinningStrategy: {
        npmManifest: 'published CLI-compatible canonical caret ranges for runtime adapters',
        exactInstallInputs: extendedInstallInputs,
        frozenInstall: 'npm ci from the generated package-lock.json',
        enforcement:
          'every phase rejects lock or installed versions that differ from the requested exact four versions',
      },
      originalScaffoldEvidence,
      journey: {
        scaffold: [
          'published CLI init',
          'doctor',
          'build',
          'codegen',
          'original demo',
          'codegen --check',
        ],
        extendedFixture: [
          'cdylib build',
          'Node stdio call',
          'Bun FFI call',
          'generated strict-contract Node entry',
          'error propagation (not declared typed domain-error handling)',
          'contract mutation',
        ],
        excluded: [
          {
            segment: 'event subscribe/unsubscribe',
            reason:
              'the public init echo scaffold declares no event contract; adding an event producer would test a separate product fixture',
          },
          {
            segment: 'Tauri and React Native',
            reason: 'this command-line gate has no GUI/mobile runtime',
          },
          {
            segment: 'five external evaluators',
            reason: 'requires independent human evaluation for G1',
          },
        ],
      },
      initialHostEvidence: initialHosts,
      phases: { baseline, candidate, rollback },
      comparison: {
        rollbackMatchesMutatedBaseline: true,
        contractHash: baselineOutput.contractHash,
        outputs: { node: baselineOutput.node, bun: baselineOutput.bun },
        classification:
          'one Rust-only patch upgrade followed by rollback; not two successive full product upgrades',
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      error.steps ??= context.steps;
      error.scratchRoot ??= scratchRoot;
      error.projectDir ??= projectDir;
    }
    throw error;
  }
}

export async function runRegistryConsumerGate({ outputPath, execute = executeRegistryCycle }) {
  const absoluteOutput = resolve(outputPath);
  const logDir = join(dirname(absoluteOutput), 'registry-consumer-logs');
  const evidenceDir = join(dirname(absoluteOutput), 'registry-consumer-evidence');
  rmSync(logDir, { recursive: true, force: true });
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date();
  let receipt;
  try {
    const result = await execute({ outputPath: absoluteOutput, logDir });
    receipt = {
      schemaVersion: 1,
      gate: 'rustra-public-registry-consumer',
      ok: true,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidenceBoundary:
        'automated public-registry CLI/Node/Bun consumer cycle; does not close G1 or G2',
      ...result,
      scratchRetained: false,
    };
    writeJson(absoluteOutput, receipt);
    if (result.scratchRoot) rmSync(result.scratchRoot, { recursive: true, force: true });
  } catch (error) {
    const step = error?.step;
    receipt = {
      schemaVersion: 1,
      gate: 'rustra-public-registry-consumer',
      ok: false,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidenceBoundary:
        'failed automated public-registry CLI/Node/Bun consumer cycle; no acceptance claim',
      steps: error?.steps ?? [],
      scratchRoot: error?.scratchRoot ?? null,
      projectDir: error?.projectDir ?? null,
      scratchRetained: Boolean(error?.scratchRoot),
      failure: {
        step: typeof step === 'string' ? step : (step?.name ?? null),
        message: errorText(error),
        code: error?.code ?? null,
        rawLogPath: step?.rawLogPath ?? null,
        diagnostics: errorDetails(error),
      },
    };
    writeJson(absoluteOutput, receipt);
  }
  return receipt;
}

async function main(argv) {
  const recoveredOutput = recoverOutputPath(argv);
  if (!recoveredOutput) {
    console.error(
      'registry consumer gate: --output must be provided exactly once with an absolute path',
    );
    process.exitCode = 1;
    return;
  }
  const receipt = await runRegistryConsumerGate({
    outputPath: recoveredOutput,
    execute: async (context) => {
      parseCliArgs(argv);
      return executeRegistryCycle(context);
    },
  });
  const stream = receipt.ok ? console.log : console.error;
  stream(`[registry-consumer] receipt: ${recoveredOutput}`);
  stream(`[registry-consumer] logs: ${join(dirname(recoveredOutput), 'registry-consumer-logs')}`);
  if (receipt.scratchRoot) stream(`[registry-consumer] scratch: ${receipt.scratchRoot}`);
  if (!receipt.ok) stream(`[registry-consumer] failed: ${receipt.failure.message}`);
  process.exitCode = receipt.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main(process.argv.slice(2));
