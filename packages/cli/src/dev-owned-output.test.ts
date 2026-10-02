import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';

function count(path: string): number {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('the adjacent handwritten Rust edit was not rebuilt');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('config dev preserves handwritten Rust beside manifest-owned output in src', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-dev-owned-output-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const runs = join(root, 'runs.log');
  const source = join(project, 'src/lib.rs');
  const configPath = join(project, 'rustra.json');
  const oldPath = process.env.PATH;
  let handle: Awaited<ReturnType<typeof runDev>> | undefined;
  for (const path of [join(project, 'src'), bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname="app"\nversion="0.1.0"\n');
  writeFileSync(join(project, 'Cargo.lock'), 'version = 3\n');
  writeFileSync(source, 'pub fn value() -> u8 { 1 }\n');
  writeFileSync(
    configPath,
    JSON.stringify({
      schema: 'schema.json',
      output: 'src',
      codegen: { rustManifest: 'Cargo.toml' },
    }),
  );
  const metadata = {
    target_directory: join(project, 'target'),
    workspace_root: project,
    packages: [
      {
        name: 'app',
        manifest_path: join(project, 'Cargo.toml'),
        targets: [
          {
            name: 'generate',
            kind: ['bin'],
            crate_types: ['bin'],
            src_path: source,
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
    else { fs.appendFileSync(${JSON.stringify(runs)},fs.readFileSync(${JSON.stringify(source)},'utf8'));
      fs.mkdirSync(process.env.RUSTRA_SCHEMA_OUT,{recursive:true});
      fs.writeFileSync(path.join(process.env.RUSTRA_SCHEMA_OUT,'schema.json'),${JSON.stringify(JSON.stringify({ packageId: 'app.demo', commands: [] }))}); }
  `,
  );
  chmodSync(cargo, 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    handle = await runDev(['--config', configPath]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(count(runs), 1, 'initial owned writes must not schedule another Cargo run');
    const reloads: string[] = [];
    handle.onReload((reason) => {
      reloads.push(reason);
    });
    writeFileSync(source, 'pub fn value() -> u8 { 2 }\n');
    await waitFor(() => count(runs) === 2 && reloads.length === 1);
    assert.match(readFileSync(runs, 'utf8'), /value\(\) -> u8 \{ 2 \}/);

    // Neither generator-owned output edits nor a same-content source touch
    // should make Cargo reconsume the unchanged handwritten source.
    writeFileSync(join(project, 'src/commands.ts'), '// owned output touch\n');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(reloads.length, 1, 'owned output writes must not emit another reload');
    const before = statSync(source);
    utimesSync(source, before.atime, new Date());
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(count(runs), 2, 'owned outputs and unchanged content must not recompile Rust');
    assert.ok(reloads.length <= 2, 'a content-unchanged touch must not create a reload loop');
  } finally {
    handle?.dispose();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
