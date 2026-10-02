import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupTauriIntegration } from './setup-tauri.js';
import { cargoDependency, rustraDependencyLine } from './setup-tauri-cargo.js';

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rustra-tauri-setup-'));
  try {
    await mkdir(join(root, 'core/src/bin'), { recursive: true });
    await mkdir(join(root, 'src-tauri/src'), { recursive: true });
    await writeFile(
      join(root, 'core/Cargo.toml'),
      '[package]\nname="setup-core"\nversion="0.1.0"\nedition="2021"\n[workspace]\n',
    );
    await writeFile(
      join(root, 'core/src/lib.rs'),
      'pub fn package() -> rustra::Package { todo!() }\n',
    );
    await writeFile(join(root, 'core/src/bin/generate.rs'), 'fn main() {}\n');
    await writeFile(
      join(root, 'src-tauri/Cargo.toml'),
      '# preserve my manifest\n[package]\nname="my-app"\nversion="0.1.0"\n[dependencies]\ntauri="2"\n',
    );
    await writeFile(
      join(root, 'src-tauri/src/lib.rs'),
      'fn run() { /* existing commands and plugins */ }\n',
    );
    await writeFile(
      join(root, 'src-tauri/tauri.conf.json'),
      JSON.stringify({
        identifier: 'dev.test.app',
        app: { windows: [{ title: 'Keep me' }], security: { csp: 'keep' } },
        plugins: { custom: true },
      }),
    );
    await writeFile(
      join(root, 'rustra.json'),
      JSON.stringify({
        schema: './generated/schema.json',
        output: './src/generated',
        codegen: { rustManifest: './core/Cargo.toml', rustBinary: 'generate' },
        tauri: {},
      }),
    );
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Tauri setup generates one-call native registration and preserves app sources/config', async () => {
  await fixture(async (root) => {
    const nativeManifest = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
    const entry = await readFile(join(root, 'src-tauri/src/lib.rs'), 'utf8');
    const result = await setupTauriIntegration(join(root, 'rustra.json'));
    const adapter = await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8');
    assert.match(adapter, /pub fn register<R: tauri::Runtime>/);
    assert.match(adapter, /rustra_setup_core::package\(\)/);
    assert.match(adapter, /pub fn with_app_commands<R, F>/);
    assert.match(adapter, /tauri_support::with_app_commands\(register\(builder\), app_handler\)/);
    assert.match(
      result.instructions.join('\n'),
      /rustra_setup_core = \{ package = "setup-core", path = "\.\.\/core" \}/,
    );
    assert.match(result.instructions.join('\n'), /mod rustra_setup;/);
    assert.match(result.instructions.join('\n'), /rustra_setup::register\(builder\)/);
    assert.equal(result.packageJsonChanged, false);
    assert.equal(await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8'), nativeManifest);
    assert.equal(await readFile(join(root, 'src-tauri/src/lib.rs'), 'utf8'), entry);
    const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.deepEqual(config, {
      identifier: 'dev.test.app',
      app: { windows: [{ title: 'Keep me' }], security: { csp: 'keep' }, withGlobalTauri: true },
      plugins: { custom: true },
    });
    assert.equal(result.files.length, 2);
  });
});

test('repeat Tauri setup leaves generated files and already-enabled config byte-identical', async () => {
  await fixture(async (root) => {
    await setupTauriIntegration(join(root, 'rustra.json'));
    const adapter = await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8');
    const config = await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8');
    const repeat = await setupTauriIntegration(join(root, 'rustra.json'));
    assert.deepEqual(repeat.files, []);
    assert.equal(await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'), adapter);
    assert.equal(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'), config);
  });
});

test('Tauri setup refuses to overwrite an edited adapter before changing global config', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'src-tauri/src/rustra_setup.rs'), '// my own registration\n');
    const config = await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8');
    await assert.rejects(
      setupTauriIntegration(join(root, 'rustra.json')),
      /Refusing to overwrite.*rustra_setup.rs/,
    );
    assert.equal(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      '// my own registration\n',
    );
    assert.equal(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'), config);
  });
});

test('Tauri setup reuses an existing renamed core dependency and its custom package function', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'core/src/lib.rs'),
      'pub fn calculator_package() -> Package { todo!() }\n',
    );
    await writeFile(
      join(root, 'src-tauri/Cargo.toml'),
      '[package]\nname="app"\nversion="0.1.0"\n[dependencies]\ntauri="2"\nrustra={path="../../rustra",features=["tauri"]}\napp_core={package="setup-core",path="../core"}\n',
    );
    const result = await setupTauriIntegration(join(root, 'rustra.json'));
    assert.match(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      /app_core::calculator_package\(\)/,
    );
    assert.doesNotMatch(result.instructions.join('\n'), /rustra_setup_core =/);
  });
});

test('Tauri setup rejects ambiguous producers without guessing or writing files', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'core/src/lib.rs'),
      'pub fn package() -> Package { todo!() }\npub fn second_package() -> Package { todo!() }\n',
    );
    await assert.rejects(
      setupTauriIntegration(join(root, 'rustra.json')),
      /package\(\).*second_package\(\)/,
    );
    const result = await setupTauriIntegration(join(root, 'rustra.json'), {
      packageFunction: 'second_package',
    });
    assert.equal(result.files.length, 2);
    assert.match(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      /second_package\(\)/,
    );
  });
});

test('Tauri setup does not infer fake factories inside comments, strings, or nested modules', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'core/src/lib.rs'),
      '// pub fn fake() -> Package {}\nconst DOC: &str = r###"pub fn fake2() -> Package {}"###;\nmod hidden { pub fn inner() -> Package { todo!() } }\n/* pub fn fake3() -> Package {} */\npub fn package() -> rustra::Package { todo!() }\n',
    );
    await setupTauriIntegration(join(root, 'rustra.json'));
    assert.match(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      /rustra_setup_core::package\(\)/,
    );
  });
});

test('Tauri setup can use the native crate itself as producer without a self-dependency', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'src-tauri/src/lib.rs'),
      'pub fn package() -> Package { todo!() }\n',
    );
    await mkdir(join(root, 'src-tauri/src/bin'));
    await writeFile(join(root, 'src-tauri/src/bin/generate.rs'), 'fn main() {}\n');
    await writeFile(
      join(root, 'rustra.json'),
      JSON.stringify({
        schema: './generated/schema.json',
        output: './src/generated',
        codegen: { rustManifest: './src-tauri/Cargo.toml', rustBinary: 'generate' },
        tauri: {},
      }),
    );
    // Avoid fetching Tauri during this metadata-only fixture; production reads real Cargo metadata.
    await writeFile(
      join(root, 'src-tauri/Cargo.toml'),
      '[package]\nname="app"\nversion="0.1.0"\nedition="2021"\n[workspace]\n',
    );
    const result = await setupTauriIntegration(join(root, 'rustra.json'));
    assert.match(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      /crate::package\(\)/,
    );
    assert.doesNotMatch(result.instructions.join('\n'), /rustra_setup_core =/);
    const nativeFixture = new URL(
      '../../../examples/tauri-calculator/src-tauri/tests/fixtures/setup_registration.rs',
      import.meta.url,
    );
    assert.equal(
      await readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'),
      await readFile(nativeFixture, 'utf8'),
      'actual generated adapter must match the compiled MockRuntime fixture',
    );
  });
});

test('Tauri setup rejects malformed app config before writing its adapter', async () => {
  await fixture(async (root) => {
    const raw = '{"app":[]}';
    await writeFile(join(root, 'src-tauri/tauri.conf.json'), raw);
    await assert.rejects(setupTauriIntegration(join(root, 'rustra.json')), /object app section/);
    assert.equal(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'), raw);
    await assert.rejects(readFile(join(root, 'src-tauri/src/rustra_setup.rs'), 'utf8'), {
      code: 'ENOENT',
    });
  });
});

test('Cargo snippet retains the producer local workspace source and features', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'Cargo.toml'),
      '[workspace]\nmembers=["core"]\n[workspace.dependencies]\nrustra={path="./matching-rustra",version="0.11.0",features=["hot-core"]}\n',
    );
    await writeFile(
      join(root, 'core/Cargo.toml'),
      '[package]\nname="setup-core"\nversion="0.1.0"\n[dependencies]\nrustra={workspace=true,features=["wasm"]}\n',
    );
    const line = rustraDependencyLine(
      cargoDependency(join(root, 'core/Cargo.toml'), 'rustra'),
      join(root, 'src-tauri'),
      '^0.11.0',
    );
    assert.match(line, /path = "\.\.\/matching-rustra"/);
    assert.match(line, /version = "0.11.0"/);
    assert.match(line, /features = \["hot-core","wasm","tauri"\]/);
    assert.doesNotMatch(line, /workspace/);
  });
});

test('Tauri setup reports the exact missing native manifest and skips other hosts', async () => {
  await fixture(async (root) => {
    await rm(join(root, 'src-tauri'), { recursive: true });
    await assert.rejects(setupTauriIntegration(join(root, 'rustra.json')), /src-tauri\/Cargo.toml/);
    await writeFile(
      join(root, 'rustra.json'),
      JSON.stringify({ schema: './generated/schema.json', output: './src/generated', node: {} }),
    );
    assert.deepEqual(await setupTauriIntegration(join(root, 'rustra.json')), {
      files: [],
      instructions: [],
      packageJsonChanged: false,
    });
  });
});
