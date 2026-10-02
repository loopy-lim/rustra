import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A local-source example, not a registry release check. Keep every generated app isolated.
const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const hostIndex = args.indexOf('--host');
const host = hostIndex < 0 ? 'node' : args[hostIndex + 1];
if (
  !['node', 'bun'].includes(host) ||
  args.some(
    (arg, index) =>
      !['--host', '--clean'].includes(arg) && (hostIndex < 0 || index !== hostIndex + 1),
  )
) {
  throw new Error('Usage: node scripts/quick-start.mjs [--host node|bun] [--clean]');
}
const clean = args.includes('--clean');
mkdirSync(join(repo, 'target'), { recursive: true });
const root = mkdtempSync(join(repo, 'target', `quick-start-${host}-`));
const app = join(root, 'app');
const cli = join(repo, 'packages/cli/dist/index.js');
const env = {
  ...process.env,
  BUN_INSTALL_CACHE_DIR: join(repo, 'target/quick-start-bun-cache'),
  TMPDIR: root,
};

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.signal ?? result.status}). Project kept at ${app}`,
    );
  }
}

let success = false;
try {
  run(process.execPath, [cli, 'init', app, '--host', host], repo);
  const manifestPath = join(app, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Consume the built candidate, so generated scripts use this CLI rather than an older registry CLI.
  for (const [section, names] of [
    ['dependencies', ['types', host]],
    ['devDependencies', ['cli']],
  ]) {
    for (const name of names)
      manifest[section][`@rustra/${name}`] = `file:${join(repo, 'packages', name)}`;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(app, '.cargo'), { recursive: true });
  writeFileSync(
    join(app, '.cargo/config.toml'),
    `[build]\ntarget-dir = ${JSON.stringify(join(repo, 'target/quick-start-shared'))}\n\n[patch.crates-io]\n${['rustra', 'rustra-macros', 'rustra-naming'].map((name) => `${name} = { path = ${JSON.stringify(join(repo, 'crates', name))} }`).join('\n')}\n`,
  );
  run(process.execPath, [cli, 'setup', '--config', join(app, 'rustra.json'), '--run'], app);
  // Exercise the user's second command too: package-manager installation must resolve the candidate CLI.
  run('bun', ['run', 'start'], app);
  success = true;
  if (!clean) {
    console.log(`\nYour ${host} example is ready: ${app}`);
    console.log('Edit src/lib.rs, then run:');
    console.log(`  cd '${app.replaceAll("'", "'\\''")}'`);
    console.log('  bun run start');
  }
} finally {
  if (clean && success) rmSync(root, { recursive: true, force: true });
}
