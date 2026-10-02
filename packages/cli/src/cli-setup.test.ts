import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './cli-main.js';

test('setup is a real CLI command and reports the missing project config', async () => {
  const argv = process.argv;
  process.argv = [argv[0]!, argv[1]!, 'setup', '--config', '/missing/rustra.json'];
  try {
    await assert.rejects(main(), /Config file not found/);
  } finally {
    process.argv = argv;
  }
});

async function project(config: Record<string, unknown> = { node: {} }) {
  const root = await mkdtemp(join(tmpdir(), 'rustra-setup-test-'));
  await writeFile(
    join(root, 'rustra.json'),
    JSON.stringify({ schema: 'generated/schema.json', output: 'src/generated', ...config }),
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'bun@1.4.0', scripts: { demo: 'bun run src/index.ts' } }),
  );
  return root;
}

test('setup generates local workspaces before installing, builds before calling, and can be repeated', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project();
  const configPath = join(root, 'rustra.json');
  const original = await readFile(join(root, 'package.json'), 'utf8');
  const steps: string[] = [];
  let generated = false;
  let installed = false;
  let built = false;
  try {
    const services = {
      preflight: () => {},
      codegen: async () => {
        generated = true;
        steps.push('generate');
      },
      native: async () => [],
      builds: () => [{ manifestPath: join(root, 'Cargo.toml'), packageName: 'app' }],
      spawn: async (command: string, args: string[], cwd: string) => {
        assert.equal(cwd, root);
        if (args[0] === 'install') {
          assert.ok(generated, 'the generated RN workspace must exist before installation');
          installed = true;
          steps.push('install');
        } else if (command === 'cargo') {
          assert.ok(generated && installed, 'runtime build must use the newly generated contract');
          built = true;
          steps.push('build');
        } else {
          assert.ok(built, 'first invocation must not use a stale runtime');
          steps.push('call');
        }
      },
    };
    await runSetup(['--config', configPath, '--run'], services);
    await runSetup(['--config', configPath, '--run'], services);
    assert.deepEqual(steps, [
      'generate',
      'install',
      'build',
      'call',
      'generate',
      'install',
      'build',
      'call',
    ]);
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed build stops the first call and gives the same safe retry command', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project();
  const calls: string[] = [];
  try {
    await assert.rejects(
      runSetup(['--config', join(root, 'rustra.json'), '--skip-install', '--run'], {
        preflight: () => {},
        codegen: async () => {},
        native: async () => [],
        builds: () => [{ manifestPath: join(root, 'Cargo.toml'), packageName: 'app' }],
        spawn: async (command: string) => {
          calls.push(command);
          throw new Error('compiler diagnostic');
        },
      }),
      /build.*compiler diagnostic[\s\S]*rustra setup.*--skip-install.*--run/,
    );
    assert.deepEqual(calls, ['cargo']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native-only projects reject --run before generation or install', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project({ tauri: {} });
  try {
    await assert.rejects(
      runSetup(['--config', join(root, 'rustra.json'), '--run'], {
        preflight: () => assert.fail('must validate the request before any setup work'),
      }),
      /--run.*Node or Bun/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup refuses arbitrary package-manager executables before mutating files', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'custom-script@1' }),
  );
  try {
    await assert.rejects(
      runSetup(['--config', join(root, 'rustra.json')], {
        preflight: () => assert.fail('must validate package manager first'),
      }),
      /Unsupported packageManager.*bun.*npm/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fresh RN adapter is installed before codegen, then its generated module is installed', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project({ reactNative: {} });
  const steps: string[] = [];
  try {
    await runSetup(['--config', join(root, 'rustra.json')], {
      preflight: () => {},
      bootstrap: async () => true,
      codegen: async () => {
        steps.push('generate');
      },
      native: async () => {
        steps.push('native');
        return ['Launch the existing app'];
      },
      builds: () => [{ manifestPath: join(root, 'Cargo.toml'), packageName: 'app' }],
      spawn: async (command, args) => {
        steps.push(command === 'cargo' ? 'build' : args[0]!);
      },
    });
    assert.deepEqual(steps, ['install', 'generate', 'native', 'install', 'build']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup rebuilds a distinct runtime crate and deduplicates shared generator/runtime crates', async () => {
  const { resolveSetupBuilds } = await import('./setup-builds.js');
  const root = await project();
  try {
    for (const [directory, name] of [
      [root, 'core'],
      [join(root, 'runtime'), 'runtime'],
    ] as const) {
      await mkdir(join(directory, 'src/bin'), { recursive: true });
      await writeFile(
        join(directory, 'Cargo.toml'),
        `[package]\nname="${name}"\nversion="0.1.0"\nedition="2021"\n[workspace]\n`,
      );
      await writeFile(join(directory, 'src/main.rs'), 'fn main() {}');
      await writeFile(join(directory, 'src/bin/generate.rs'), 'fn main() {}');
    }
    const base = { schema: 'schema.json', output: 'generated' };
    const configPath = join(root, 'rustra.json');
    assert.equal(resolveSetupBuilds(configPath, { ...base, node: {} }).length, 1);
    const builds = resolveSetupBuilds(configPath, {
      ...base,
      node: { rustManifest: 'runtime/Cargo.toml' },
    });
    assert.deepEqual(
      builds.map((build) => build.packageName),
      ['core', 'runtime'],
    );
    assert.equal(builds[1]!.manifestPath, join(root, 'runtime/Cargo.toml'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('core setup does not require mobile CMake or C++ tools before explicit native preparation', async () => {
  const { checkSetupTools } = await import('./cli-setup.js');
  const commands: string[] = [];
  assert.doesNotThrow(() =>
    checkSetupTools(
      '/project/rustra.json',
      {
        schema: 'schema.json',
        output: 'generated',
        reactNative: {},
      },
      'bun',
      true,
      (command) => {
        commands.push(command);
        return {
          ok: ['rustc', 'cargo', 'bun'].includes(command),
          stdout: command === 'rustc' ? 'rustc 1.98.0' : command === 'bun' ? '1.4.1' : '1.0.0',
          stderr: '',
        };
      },
    ),
  );
  assert.ok(!commands.includes('cmake') && !commands.includes('c++'));
});

test('RN setup selects the same static library from a virtual workspace as codegen', async () => {
  const { resolveSetupBuilds } = await import('./setup-builds.js');
  const root = await project({ reactNative: {} });
  const write = async (name: string, body: string) => {
    const { dirname } = await import('node:path');
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  };
  try {
    await write('Cargo.toml', '[workspace]\nmembers=["schema","mobile"]\nresolver="2"\n');
    await write(
      'schema/Cargo.toml',
      '[package]\nname="schema-probe"\nversion="0.1.0"\nedition="2021"\n',
    );
    await write('schema/src/bin/generate.rs', 'fn main() {}');
    await write(
      'mobile/Cargo.toml',
      '[package]\nname="mobile-core"\nversion="0.1.0"\nedition="2021"\n[lib]\ncrate-type=["rlib","staticlib"]\n',
    );
    await write('mobile/src/lib.rs', 'pub fn value() -> u8 { 1 }');
    const builds = resolveSetupBuilds(join(root, 'rustra.json'), {
      schema: 'schema.json',
      output: 'generated',
      codegen: { rustManifest: 'schema/Cargo.toml' },
      reactNative: { rustManifest: 'Cargo.toml' },
    });
    assert.deepEqual(
      builds.map((build) => build.packageName),
      ['schema-probe', 'mobile-core'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup keeps the selected Cargo invocation directory for a separate RN core', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project({ reactNative: {} });
  const core = join(root, 'native-core');
  try {
    await runSetup(['--config', join(root, 'rustra.json'), '--skip-install'], {
      preflight: () => {},
      codegen: async () => {},
      native: async () => [],
      builds: () => [{ manifestPath: join(core, 'Cargo.toml'), packageName: 'mobile', cwd: core }],
      spawn: async (_command, _args, cwd) => {
        assert.equal(cwd, core);
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup respects an existing package-manager lockfile when packageManager is omitted', async () => {
  const { runSetup } = await import('./cli-setup.js');
  const root = await project();
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  const commands: string[] = [];
  try {
    await runSetup(['--config', join(root, 'rustra.json')], {
      preflight: () => {},
      codegen: async () => {},
      native: async () => [],
      builds: () => [],
      spawn: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ['pnpm']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
