import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';

function fixture(nestedApp = false) {
  const root = mkdtempSync(join(tmpdir(), 'rustra-legacy-dev-'));
  const backend = join(root, 'backend');
  const app = nestedApp ? join(backend, 'src/app') : join(root, 'app');
  const dependency = join(root, 'dependency');
  const bin = join(root, 'bin');
  for (const dir of [join(backend, 'src'), join(dependency, 'src'), app, bin])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(backend, 'Cargo.toml'), '[package]\nname="backend"\nversion="0.1.0"\n');
  writeFileSync(join(backend, 'Cargo.lock'), 'version = 3\n');
  writeFileSync(join(backend, 'build.rs'), 'fn main() {}\n');
  writeFileSync(join(backend, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }\n');
  writeFileSync(join(backend, 'src/extra.rs'), 'pub const EXTRA: u8 = 0;\n');
  writeFileSync(join(dependency, 'Cargo.toml'), '[package]\nname="dependency"\nversion="0.1.0"\n');
  writeFileSync(join(dependency, 'src/lib.rs'), 'pub const VALUE: u8 = 1;\n');
  const runs = join(root, 'runs.log');
  const schema = join(app, 'generated/schema.json');
  const target = join(backend, 'src/compiled-output');
  const metadata = {
    target_directory: target,
    workspace_root: backend,
    packages: [
      {
        name: 'backend',
        manifest_path: join(backend, 'Cargo.toml'),
        dependencies: [{ path: dependency }],
        targets: [
          {
            name: 'generate',
            kind: ['bin'],
            crate_types: ['bin'],
            src_path: join(backend, 'src/lib.rs'),
          },
        ],
      },
      {
        name: 'dependency',
        manifest_path: join(dependency, 'Cargo.toml'),
        targets: [
          {
            name: 'dependency',
            kind: ['lib'],
            crate_types: ['rlib'],
            src_path: join(dependency, 'src/lib.rs'),
          },
        ],
      },
    ],
  };
  const cargo = join(bin, 'cargo');
  writeFileSync(
    cargo,
    `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
    if(process.argv[2]==='metadata') console.log(${JSON.stringify(JSON.stringify(metadata))});
    else { fs.appendFileSync(${JSON.stringify(runs)},'run\\n');fs.mkdirSync(path.dirname(${JSON.stringify(schema)}),{recursive:true});fs.writeFileSync(${JSON.stringify(schema)},'{}'); }
  `,
  );
  chmodSync(cargo, 0o755);
  const cli = join(root, 'cli.mjs');
  writeFileSync(
    cli,
    `import fs from 'node:fs';import {createHash} from 'node:crypto';const content='export {};';
    fs.writeFileSync(${JSON.stringify(join(app, 'generated/frame-codecs.ts'))},content);
    fs.writeFileSync(${JSON.stringify(join(app, 'generated/.rustra-generated.json'))},JSON.stringify({schemaVersion:1,files:[{path:'frame-codecs.ts',sha256:createHash('sha256').update(content).digest('hex')}]}));`,
  );
  return { root, backend, app, dependency, bin, runs, cli, target };
}

function count(path: string): number {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('legacy regeneration did not observe the changed input');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const edits: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'Cargo.toml',
    (f) =>
      writeFileSync(join(f.backend, 'Cargo.toml'), '[package]\nname="backend"\nversion="0.1.1"\n'),
  ],
  ['Cargo.lock', (f) => writeFileSync(join(f.backend, 'Cargo.lock'), 'version = 4\n')],
  [
    'build.rs',
    (f) => writeFileSync(join(f.backend, 'build.rs'), 'fn main() { println!("changed"); }\n'),
  ],
  [
    'same-mtime Rust content',
    (f) => {
      const path = join(f.backend, 'src/lib.rs');
      const before = statSync(path);
      writeFileSync(path, 'pub fn value() -> u8 { 2 }\n');
      utimesSync(path, before.atime, before.mtime);
    },
  ],
  ['Rust source deletion', (f) => unlinkSync(join(f.backend, 'src/extra.rs'))],
  [
    'local dependency source',
    (f) => writeFileSync(join(f.dependency, 'src/lib.rs'), 'pub const VALUE: u8 = 2;\n'),
  ],
];

test('legacy dev watches handwritten Rust adjacent to generated files', async () => {
  const f = fixture(true);
  const source = join(f.app, 'generated/handwritten.rs');
  mkdirSync(join(f.app, 'generated'), { recursive: true });
  writeFileSync(source, 'pub const VALUE: u8 = 1;\n');
  const oldPath = process.env.PATH;
  const oldCli = process.env.RUSTRA_CLI;
  process.env.PATH = `${f.bin}:${oldPath}`;
  process.env.RUSTRA_CLI = f.cli;
  let handle: Awaited<ReturnType<typeof runDev>> | undefined;
  try {
    handle = await runDev(['--backend', f.backend, '--app', f.app]);
    const reloads: string[] = [];
    handle.onReload((reason) => {
      reloads.push(reason);
    });
    writeFileSync(source, 'pub const VALUE: u8 = 2;\n');
    await waitFor(() => count(f.runs) === 2 && reloads.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(count(f.runs), 2);
  } finally {
    await handle?.dispose();
    process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.RUSTRA_CLI;
    else process.env.RUSTRA_CLI = oldCli;
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [name, edit] of edits) {
  test(`legacy dev rebuilds and reloads after ${name} changes`, async () => {
    const f = fixture();
    const oldPath = process.env.PATH;
    const oldCli = process.env.RUSTRA_CLI;
    process.env.PATH = `${f.bin}:${oldPath}`;
    process.env.RUSTRA_CLI = f.cli;
    let handle: Awaited<ReturnType<typeof runDev>> | undefined;
    try {
      handle = await runDev(['--backend', f.backend, '--app', f.app]);
      assert.equal(count(f.runs), 1);
      const reloads: string[] = [];
      handle.onReload((reason) => {
        reloads.push(reason);
      });
      edit(f);
      await waitFor(() => count(f.runs) === 2 && reloads.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(count(f.runs), 2, 'successful output must not trigger another rebuild');
    } finally {
      await handle?.dispose();
      process.env.PATH = oldPath;
      if (oldCli === undefined) delete process.env.RUSTRA_CLI;
      else process.env.RUSTRA_CLI = oldCli;
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('legacy dev skips unchanged touches and excludes owned/custom target output', async () => {
  const f = fixture(true);
  const oldPath = process.env.PATH;
  const oldCli = process.env.RUSTRA_CLI;
  process.env.PATH = `${f.bin}:${oldPath}`;
  process.env.RUSTRA_CLI = f.cli;
  let handle: Awaited<ReturnType<typeof runDev>> | undefined;
  try {
    handle = await runDev(['--backend', f.backend, '--app', f.app]);
    assert.equal(count(f.runs), 1);
    const now = new Date();
    utimesSync(join(f.backend, 'src/lib.rs'), now, now);
    writeFileSync(join(f.app, 'generated/frame-codecs.ts'), '// owned output touch\n');
    mkdirSync(f.target, { recursive: true });
    writeFileSync(join(f.target, 'artifact.o'), 'compiler output');
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(count(f.runs), 1, 'touches and output changes must not recompile Rust');
  } finally {
    await handle?.dispose();
    process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.RUSTRA_CLI;
    else process.env.RUSTRA_CLI = oldCli;
    rmSync(f.root, { recursive: true, force: true });
  }
});
