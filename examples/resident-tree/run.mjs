import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args, capture = false, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 300_000,
    env,
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`${command} exited ${result.status}`);
  return result.stdout;
}
run('cargo', ['build', '-p', 'rustra', '--example', 'resident_tree']);
const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1'], true));
const executable = join(
  metadata.target_directory,
  'debug',
  'examples',
  `resident_tree${process.platform === 'win32' ? '.exe' : ''}`,
);
mkdirSync(new URL('generated/', import.meta.url), { recursive: true });
writeFileSync(new URL('generated/schema.json', import.meta.url), run(executable, ['schema'], true));
run('node', [
  'packages/cli/dist/index.js',
  'generate',
  '--schema',
  'examples/resident-tree/generated/schema.json',
  '--output',
  'examples/resident-tree/generated',
]);
run('bun', ['run', 'test:app:resident-tree:client'], false, {
  ...process.env,
  RUSTRA_RESIDENT_BINARY: executable,
});
