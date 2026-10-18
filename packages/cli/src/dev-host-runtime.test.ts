import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('watch runtime transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const host of ['node', 'bun'] as const) {
  test(
    `dev rebuilds a separate ${host} producer and suppresses reload until runtime recovery`,
    {
      skip: process.platform === 'win32' ? 'fixture uses a POSIX executable Cargo shim' : false,
    },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rustra-dev-runtime-'));
      const generator = join(root, 'generator');
      const runtime = join(root, 'runtime');
      const bin = join(root, 'bin');
      const source = join(runtime, 'src', 'lib.rs');
      const artifact = join(root, 'target', 'runtime.txt');
      const attempts = join(root, 'target', 'attempts.log');
      const configPath = join(root, 'rustra.json');
      const oldPath = process.env.PATH;
      const oldError = console.error;
      const failures: string[] = [];
      let handle: Awaited<ReturnType<typeof runDev>> | undefined;
      for (const dir of [join(generator, 'src'), join(runtime, 'src'), bin, join(root, 'target')])
        mkdirSync(dir, { recursive: true });
      for (const [dir, name] of [
        [generator, 'generator'],
        [runtime, 'runtime'],
      ])
        writeFileSync(join(dir!, 'Cargo.toml'), `[package]\nname="${name}"\nversion="0.1.0"\n`);
      writeFileSync(join(generator, 'src', 'main.rs'), 'generator');
      writeFileSync(source, 'first runtime');
      writeFileSync(artifact, 'stale runtime');
      const config = JSON.stringify({
        schema: 'generated/schema.json',
        output: 'generated',
        codegen: { rustManifest: 'generator/Cargo.toml' },
        [host]: { rustManifest: 'runtime/Cargo.toml' },
      });
      writeFileSync(configPath, config);
      writeFileSync(join(root, 'package.json'), '{"name":"watch-runtime-fixture","private":true}');
      const metadata = {
        target_directory: join(root, 'target'),
        workspace_root: root,
        packages: [
          {
            name: 'generator',
            manifest_path: join(generator, 'Cargo.toml'),
            targets: [
              {
                name: 'generate',
                kind: ['bin'],
                crate_types: ['bin'],
                src_path: join(generator, 'src/main.rs'),
              },
            ],
          },
          {
            name: 'runtime',
            manifest_path: join(runtime, 'Cargo.toml'),
            targets: [
              {
                name: 'runtime',
                kind: [host === 'node' ? 'bin' : 'cdylib'],
                crate_types: [host === 'node' ? 'bin' : 'cdylib'],
                src_path: source,
              },
            ],
          },
        ],
      };
      writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
      const cargo = join(bin, 'cargo');
      writeFileSync(
        cargo,
        `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='metadata') console.log(${JSON.stringify(JSON.stringify(metadata))});
else if(args[0]==='run') {
 fs.mkdirSync(process.env.RUSTRA_SCHEMA_OUT,{recursive:true});
 fs.writeFileSync(path.join(process.env.RUSTRA_SCHEMA_OUT,'schema.json'),${JSON.stringify(JSON.stringify({ packageId: 'runtime.probe', commands: [] }))});
} else if(args[0]==='build' && args[args.indexOf('--package')+1]==='runtime') {
 const source=fs.readFileSync(${JSON.stringify(source)},'utf8');
 fs.appendFileSync(${JSON.stringify(attempts)},source+'\\n');
 if(source.includes('broken')) { console.error('runtime compilation failed'); process.exit(1); }
 fs.writeFileSync(${JSON.stringify(artifact)},source);
}
`,
      );
      chmodSync(cargo, 0o755);
      process.env.PATH = `${bin}:${oldPath}`;
      console.error = (...args) => {
        failures.push(args.join(' '));
      };
      try {
        handle = await runDev(['--config', configPath]);
        assert.equal(readFileSync(artifact, 'utf8'), 'first runtime', failures.join('\n'));
        let reloads = 0;
        handle.onReload(() => {
          reloads++;
        });
        writeFileSync(source, 'second runtime');
        await until(() => reloads > 0);
        assert.equal(readFileSync(artifact, 'utf8'), 'second runtime');
        const successful = reloads;
        writeFileSync(source, 'broken runtime');
        await until(() => failures.some((line) => line.includes('regeneration failed')));
        assert.equal(
          reloads,
          successful,
          'a generator success cannot hide a runtime build failure',
        );
        assert.equal(readFileSync(artifact, 'utf8'), 'second runtime');
        const beforeRepair = readFileSync(attempts, 'utf8');
        writeFileSync(source, 'second runtime');
        await until(() => reloads > successful);
        assert.notEqual(
          readFileSync(attempts, 'utf8'),
          beforeRepair,
          'restoring the exact last successful input must retry after a failed build',
        );
        const repaired = reloads;
        writeFileSync(source, 'recovered runtime');
        await until(() => reloads > repaired);
        assert.equal(readFileSync(artifact, 'utf8'), 'recovered runtime');
        assert.equal(readFileSync(configPath, 'utf8'), config, 'dev preserves host settings');
      } finally {
        await handle?.dispose();
        process.env.PATH = oldPath;
        console.error = oldError;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
