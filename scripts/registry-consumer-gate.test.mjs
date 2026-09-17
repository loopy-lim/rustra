import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertCargoProvenance,
  assertExactNpmProvenance,
  assertNoConsumerContamination,
  assertPhaseOutput,
  parseCliArgs,
  prepareRegistryFixture,
  runOrderedSteps,
  runRegistryConsumerGate,
  validateVersionManifest,
} from './registry-consumer-gate.mjs';

const NPM = {
  '@rustra/cli': '0.10.0',
  '@rustra/types': '0.10.0',
  '@rustra/node': '0.10.0',
  '@rustra/bun': '0.10.0',
};
const RUST = {
  rustra: '0.10.0',
  'rustra-macros': '0.10.0',
  'rustra-naming': '0.10.0',
};

function scratch(prefix = 'rustra-registry-gate-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedNpmConsumer(root, { mismatchVersion } = {}) {
  writeJson(join(root, 'package.json'), { private: true, dependencies: NPM });
  const packages = { '': { dependencies: NPM } };
  for (const [name, version] of Object.entries(NPM)) {
    const installed = mismatchVersion && name === '@rustra/node' ? mismatchVersion : version;
    const packageDir = join(root, 'node_modules', ...name.split('/'));
    writeJson(join(packageDir, 'package.json'), { name, version: installed });
    packages[`node_modules/${name}`] = {
      version: installed,
      resolved: `https://registry.npmjs.org/${name.replace('/', '%2f')}/-/${name.split('/')[1]}-${installed}.tgz`,
      integrity: 'sha512-fixture',
    };
  }
  writeJson(join(root, 'package-lock.json'), {
    name: 'registry-consumer',
    lockfileVersion: 3,
    packages,
  });
}

function cargoMetadata({ mismatch = false, pathDependency = false } = {}) {
  return {
    packages: [
      {
        name: 'registry-consumer',
        version: '0.1.0',
        source: null,
        manifest_path: '/tmp/registry-consumer/Cargo.toml',
      },
      ...Object.entries(RUST).map(([name, version]) => ({
        name,
        version: mismatch && name === 'rustra' ? '0.9.0' : version,
        source:
          pathDependency && name === 'rustra'
            ? null
            : 'registry+https://github.com/rust-lang/crates.io-index',
        manifest_path: pathDependency
          ? `/tmp/external/${name}/Cargo.toml`
          : `/cargo/registry/src/${name}-${version}/Cargo.toml`,
      })),
    ],
  };
}

const CARGO_LOCK = `version = 4

[[package]]
name = "registry-consumer"
version = "0.1.0"

[[package]]
name = "rustra"
version = "0.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaa"

[[package]]
name = "rustra-macros"
version = "0.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbb"

[[package]]
name = "rustra-naming"
version = "0.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "ccc"
`;

test('CLI accepts one absolute --output and rejects malformed or unknown options', () => {
  assert.deepEqual(parseCliArgs(['--output', '/tmp/registry/receipt.json']), {
    outputPath: '/tmp/registry/receipt.json',
  });
  assert.throws(() => parseCliArgs([]), /--output/);
  assert.throws(() => parseCliArgs(['--output', 'relative.json']), /absolute/);
  assert.throws(() => parseCliArgs(['--wat', 'x', '--output', '/tmp/r.json']), /unknown option/);
  assert.throws(
    () => parseCliArgs(['--output', '/tmp/a.json', '--output', '/tmp/b.json']),
    /exactly once/,
  );
});

test('version manifest requires exact semver pins and the three named phases', () => {
  assert.doesNotThrow(() =>
    validateVersionManifest({
      schemaVersion: 1,
      npm: NPM,
      phases: {
        baseline: RUST,
        candidate: {
          ...RUST,
          rustra: '0.10.1',
          'rustra-macros': '0.10.1',
          'rustra-naming': '0.10.1',
        },
        rollback: RUST,
      },
    }),
  );
  assert.throws(
    () =>
      validateVersionManifest({
        schemaVersion: 1,
        npm: { ...NPM, '@rustra/node': '^0.10.0' },
        phases: { baseline: RUST, candidate: RUST, rollback: RUST },
      }),
    /exact version/,
  );
});

test('contamination scan rejects package overrides and workspace/file/git npm dependencies', () => {
  const variants = [
    { overrides: { '@rustra/node': 'file:../node' } },
    { dependencies: { '@rustra/node': 'workspace:*' } },
    { dependencies: { '@rustra/node': 'file:../node' } },
    { dependencies: { '@rustra/node': 'git+https://example.invalid/node.git' } },
  ];
  for (const extra of variants) {
    const { root, cleanup } = scratch();
    try {
      writeJson(join(root, 'package.json'), { private: true, ...extra });
      writeFileSync(
        join(root, 'Cargo.toml'),
        '[package]\nname="registry-consumer"\nversion="0.1.0"\n',
      );
      assert.throws(() => assertNoConsumerContamination(root), /contamination/);
    } finally {
      cleanup();
    }
  }
});

test('contamination scan accepts only the CLI-compatible caret for the requested npm line', () => {
  const { root, cleanup } = scratch();
  try {
    writeJson(join(root, 'package.json'), {
      private: true,
      dependencies: {
        '@rustra/node': '^0.10.0',
        '@rustra/types': '^0.10.0',
        '@rustra/bun': '^0.10.0',
      },
      devDependencies: { '@rustra/cli': '0.10.0' },
    });
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="registry-consumer"\nversion="0.1.0"\n',
    );
    assert.doesNotThrow(() => assertNoConsumerContamination(root, { expectedNpm: NPM }));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@rustra/node'] = '^0.10.1';
    writeJson(join(root, 'package.json'), manifest);
    assert.throws(
      () => assertNoConsumerContamination(root, { expectedNpm: NPM }),
      /unsupported version spec.*\^0\.10\.1/,
    );
  } finally {
    cleanup();
  }
});

test('contamination scan rejects Cargo patch, path and git dependencies', () => {
  for (const dependency of [
    'rustra = { path = "../rustra" }',
    'rustra = { git = "https://example.invalid/rustra" }',
    '[patch.crates-io]\nrustra = { path = "../rustra" }',
  ]) {
    const { root, cleanup } = scratch();
    try {
      writeJson(join(root, 'package.json'), { private: true });
      writeFileSync(
        join(root, 'Cargo.toml'),
        `[package]\nname="registry-consumer"\nversion="0.1.0"\n[dependencies]\n${dependency}\n`,
      );
      assert.throws(() => assertNoConsumerContamination(root), /contamination/);
    } finally {
      cleanup();
    }
  }
});

test('contamination scan permits ordinary Cargo target path keys from the real scaffold shape', () => {
  const { root, cleanup } = scratch();
  try {
    writeJson(join(root, 'package.json'), { private: true, dependencies: NPM });
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname="registry-consumer"\nversion="0.1.0"\n\n[dependencies]\nrustra = "=0.10.0"\nrustra-macros = "=0.10.0"\nrustra-naming = "=0.10.0"\n\n[[bin]]\nname = "generate"\npath = "src/bin/generate.rs"\n`,
    );
    assert.doesNotThrow(() => assertNoConsumerContamination(root));
  } finally {
    cleanup();
  }
});

test('contamination scan rejects installed Rustra package symlinks', () => {
  const { root, cleanup } = scratch();
  try {
    writeJson(join(root, 'package.json'), { private: true, dependencies: NPM });
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="registry-consumer"\nversion="0.1.0"\n',
    );
    mkdirSync(join(root, 'node_modules', '@rustra'), { recursive: true });
    const external = mkdtempSync(join(tmpdir(), 'rustra-registry-external-'));
    symlinkSync(external, join(root, 'node_modules', '@rustra', 'node'), 'dir');
    try {
      assert.throws(() => assertNoConsumerContamination(root), /symlink/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test('npm provenance proves exact installed versions and registry tarball sources', () => {
  const { root, cleanup } = scratch();
  try {
    seedNpmConsumer(root);
    const proof = assertExactNpmProvenance(root, NPM);
    assert.equal(proof['@rustra/node'].version, '0.10.0');
    assert.match(proof['@rustra/node'].resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.equal(proof['@rustra/node'].integrity, 'sha512-fixture');
  } finally {
    cleanup();
  }
});

test('npm provenance rejects a resolved version mismatch', () => {
  const { root, cleanup } = scratch();
  try {
    seedNpmConsumer(root, { mismatchVersion: '0.9.0' });
    assert.throws(() => assertExactNpmProvenance(root, NPM), /@rustra\/node.*0\.9\.0.*0\.10\.0/);
  } finally {
    cleanup();
  }
});

test('npm provenance rejects a newer patch resolved through the allowed caret', () => {
  const { root, cleanup } = scratch();
  try {
    seedNpmConsumer(root, { mismatchVersion: '0.10.1' });
    assert.throws(() => assertExactNpmProvenance(root, NPM), /@rustra\/node.*0\.10\.1.*0\.10\.0/);
  } finally {
    cleanup();
  }
});

test('Cargo provenance allows only the root consumer without registry source', () => {
  const proof = assertCargoProvenance({
    metadata: cargoMetadata(),
    lockText: CARGO_LOCK,
    expected: RUST,
    consumerManifestPath: '/tmp/registry-consumer/Cargo.toml',
  });
  assert.equal(proof.rustra.version, '0.10.0');
  assert.equal(proof.rustra.checksum, 'aaa');
  assert.throws(
    () =>
      assertCargoProvenance({
        metadata: cargoMetadata({ pathDependency: true }),
        lockText: CARGO_LOCK,
        expected: RUST,
        consumerManifestPath: '/tmp/registry-consumer/Cargo.toml',
      }),
    /non-registry Cargo source/,
  );
});

test('Cargo provenance canonicalizes the root manifest path but still rejects another path package', () => {
  const { root, cleanup } = scratch();
  const actual = join(root, 'actual');
  const alias = join(root, 'alias');
  try {
    mkdirSync(actual, { recursive: true });
    writeFileSync(join(actual, 'Cargo.toml'), '[package]\nname="registry-consumer"\n');
    symlinkSync(actual, alias, 'dir');
    const metadata = cargoMetadata();
    metadata.packages[0].manifest_path = join(actual, 'Cargo.toml');
    assert.doesNotThrow(() =>
      assertCargoProvenance({
        metadata,
        lockText: CARGO_LOCK,
        expected: RUST,
        consumerManifestPath: join(alias, 'Cargo.toml'),
      }),
    );
    metadata.packages.push({
      name: 'local-helper',
      version: '0.1.0',
      source: null,
      manifest_path: join(root, 'local-helper', 'Cargo.toml'),
    });
    assert.throws(
      () =>
        assertCargoProvenance({
          metadata,
          lockText: CARGO_LOCK,
          expected: RUST,
          consumerManifestPath: join(alias, 'Cargo.toml'),
        }),
      /local-helper.*non-registry Cargo source/,
    );
  } finally {
    cleanup();
  }
});

test('Cargo provenance rejects a custom registry even when Cargo labels it registry+', () => {
  const metadata = cargoMetadata();
  metadata.packages.find((pkg) => pkg.name === 'rustra').source =
    'registry+https://packages.example.invalid/index';
  assert.throws(
    () =>
      assertCargoProvenance({
        metadata,
        lockText: CARGO_LOCK,
        expected: RUST,
        consumerManifestPath: '/tmp/registry-consumer/Cargo.toml',
      }),
    /crates\.io/,
  );
});

test('registry fixture pins all Rustra crates and exports the cdylib native entry', () => {
  const { root, cleanup } = scratch();
  try {
    writeJson(join(root, 'package.json'), {
      private: true,
      dependencies: { '@rustra/node': '^0.10.0', '@rustra/types': '^0.10.0' },
      devDependencies: { '@rustra/cli': '^0.10.0' },
    });
    writeJson(join(root, 'rustra.json'), {
      schema: './generated/schema.json',
      output: './src/generated',
      node: {},
    });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]\nname="registry-consumer"\nversion="0.1.0"\n\n[dependencies]\nrustra = "^0.10.0"\nrustra-macros = "^0.10.0"\n\n[[bin]]\nname="generate"\npath="src/bin/generate.rs"\n`,
    );
    writeFileSync(
      join(root, 'src', 'lib.rs'),
      `use rustra::prelude::*;\n\n#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]\npub struct EchoInput { pub message: String }\n#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]\npub struct EchoOutput { pub message: String }\n#[rustra::command]\nfn echo(input: EchoInput) -> Result<EchoOutput> { Ok(EchoOutput { message: input.message }) }\npub fn package() -> Package { Package::builder("app.demo").command_fn(echo).build() }\n`,
    );
    prepareRegistryFixture(root, {
      schemaVersion: 1,
      npm: NPM,
      phases: {
        baseline: RUST,
        candidate: { rustra: '0.10.1', 'rustra-macros': '0.10.1', 'rustra-naming': '0.10.1' },
        rollback: RUST,
      },
    });
    const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
    const lib = readFileSync(join(root, 'src', 'lib.rs'), 'utf8');
    assert.match(cargo, /rustra-naming = "=0\.10\.0"/);
    assert.match(cargo, /crate-type = \["rlib", "cdylib"\]/);
    assert.match(lib, /rustra::native_entry!\(package\);/);
    assert.match(
      lib,
      /pub fn package\(\) -> Package \{\s*let package = Package::builder\("app\.demo"\)\.command_fn\(echo\)\.command_fn\(fail_echo\)\.build\(\);\s*package\.register_ffi\(\);\s*package\s*\}/,
    );
    assert.doesNotMatch(lib, /Package::builder\("app\.demo"\)\s*let package/);
    assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"@rustra\/bun": "\^0\.10\.0"/);
    assert.doesNotThrow(() => assertNoConsumerContamination(root, { expectedNpm: NPM }));
  } finally {
    cleanup();
  }
});

test('Cargo provenance rejects a resolved version mismatch', () => {
  assert.throws(
    () =>
      assertCargoProvenance({
        metadata: cargoMetadata({ mismatch: true }),
        lockText: CARGO_LOCK,
        expected: RUST,
        consumerManifestPath: '/tmp/registry-consumer/Cargo.toml',
      }),
    /rustra.*0\.9\.0.*0\.10\.0/,
  );
});

test('ordered runner aborts at first error and retains raw logs including spawn diagnostics', async () => {
  const { root, cleanup } = scratch();
  const ran = [];
  try {
    const result = await runOrderedSteps({
      logDir: root,
      steps: [{ name: 'first' }, { name: 'broken' }, { name: 'never' }],
      runner: async (step) => {
        ran.push(step.name);
        if (step.name === 'broken') {
          const error = new Error('spawn cargo ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(ran, ['first', 'broken']);
    assert.equal(result.steps.at(-1).name, 'broken');
    assert.match(result.error.message, /spawn cargo ENOENT/);
    assert.match(readFileSync(result.steps.at(-1).rawLogPath, 'utf8'), /ENOENT/);
  } finally {
    cleanup();
  }
});

test('phase output verification checks the added field and rollback equality', () => {
  const baseline = {
    contractHash: 'abc',
    node: { message: 'hello', repeat: 3 },
    bun: { message: 'hello', repeat: 3 },
  };
  assert.doesNotThrow(() => assertPhaseOutput({ phase: 'candidate', output: baseline, baseline }));
  assert.throws(
    () =>
      assertPhaseOutput({
        phase: 'rollback',
        output: { ...baseline, bun: { message: 'hello' } },
        baseline,
      }),
    /repeat/,
  );
  assert.throws(
    () =>
      assertPhaseOutput({
        phase: 'rollback',
        output: { ...baseline, contractHash: 'different' },
        baseline,
      }),
    /rollback contract hash/,
  );
});

test('gate writes a receipt on executor failure and points to retained logs', async () => {
  const { root, cleanup } = scratch();
  try {
    const outputPath = join(root, 'artifacts', 'receipt.json');
    const result = await runRegistryConsumerGate({
      outputPath,
      execute: async ({ logDir }) => {
        mkdirSync(logDir, { recursive: true });
        const rawLogPath = join(logDir, 'prepare.log');
        writeFileSync(rawLogPath, 'registry unavailable\n');
        const error = new Error('registry unavailable');
        error.step = { name: 'prepare', rawLogPath };
        throw error;
      },
    });
    assert.equal(result.ok, false);
    const receipt = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failure.step, 'prepare');
    assert.equal(readFileSync(receipt.failure.rawLogPath, 'utf8'), 'registry unavailable\n');
  } finally {
    cleanup();
  }
});

test('CLI writes a failure receipt and exits 1 for an unknown option', () => {
  const { root, cleanup } = scratch();
  try {
    const outputPath = join(root, 'receipt.json');
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/registry-consumer-gate.mjs'), '--output', outputPath, '--unknown'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    const receipt = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(receipt.ok, false);
    assert.match(receipt.failure.message, /unknown option/);
    assert.match(result.stderr, /receipt:/);
  } finally {
    cleanup();
  }
});
