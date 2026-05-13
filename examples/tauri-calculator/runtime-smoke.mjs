import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const binary = join(root, 'target/release/rustra-tauri-calculator');
const tempDir = await mkdtemp(join(tmpdir(), 'rustra-tauri-'));
const probeFile = join(tempDir, 'probe.txt');

const app = spawn(binary, [], {
  cwd: root,
  env: {
    ...process.env,
    RUSTRA_TAURI_PROBE_FILE: probeFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
app.stderr.setEncoding('utf8');
app.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

for (let i = 0; i < 40; i += 1) {
  if (existsSync(probeFile)) {
    break;
  }

  await wait(250);
}

app.kill();

const value = existsSync(probeFile) ? (await readFile(probeFile, 'utf8')).trim() : '';

if (value !== '42') {
  throw new Error(`expected Tauri runtime probe to write 42, got "${value}". stderr: ${stderr}`);
}

console.log(`tauri runtime probe result: ${value}`);
