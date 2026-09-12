import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWatch, createSourceWatch, createWatchLoop } from './watch.js';

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(predicate(), 'expected filesystem change was not delivered');
}

test('source watch follows directories created after startup and recreated roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-'));
  const src = join(root, 'src');
  mkdirSync(src);
  const events: string[] = [];
  const handle = createSourceWatch(src, (path) => events.push(path));
  try {
    const file = join(src, 'new', 'nested', 'lib.rs');
    mkdirSync(join(src, 'new', 'nested'), { recursive: true });
    writeFileSync(file, 'one');
    await until(() => events.includes(file));
    events.length = 0;
    rmSync(src, { recursive: true });
    await new Promise((r) => setTimeout(r, 150));
    mkdirSync(join(src, 'new', 'nested'), { recursive: true });
    writeFileSync(file, 'two');
    await until(() => events.includes(file));
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('file watch follows initially missing and atomically replaced files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-'));
  const file = join(root, 'rustra.json');
  let changes = 0;
  const handle = createFileWatch([{ path: file, onChange: () => changes++ }]);
  try {
    writeFileSync(file, 'one');
    await until(() => changes > 0);
    const previous = changes;
    writeFileSync(join(root, 'new.json'), 'two');
    renameSync(join(root, 'new.json'), file);
    await until(() => changes > previous);
    handle.dispose();
    const disposed = changes;
    writeFileSync(file, 'three');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(changes, disposed);
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled pipeline failures are reported and the next run recovers', async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  let attempts = 0;
  const loop = createWatchLoop(
    async () => {
      if (++attempts === 1) throw new Error('broken');
    },
    () => true,
    1,
  );
  try {
    loop.schedule('first');
    await until(() => errors.length > 0);
    assert.match(String(errors[0]), /broken/);
    loop.schedule('retry');
    await until(() => attempts === 2);
  } finally {
    loop.dispose();
    console.error = original;
  }
});

test('polling reports transient read failures and recovers without dropping the subscription', async () => {
  const { chmodSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-permission-'));
  const src = join(root, 'src');
  mkdirSync(src);
  const file = join(src, 'lib.rs');
  writeFileSync(file, 'one');
  const events: string[] = [];
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  const watch = createSourceWatch(src, (path) => events.push(path));
  try {
    chmodSync(src, 0);
    await until(() => errors.length > 0);
    chmodSync(src, 0o700);
    writeFileSync(file, 'two');
    await until(() => events.includes(file));
  } finally {
    chmodSync(src, 0o700);
    watch.dispose();
    console.error = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema watch reloads config and follows a newly selected schema file', async () => {
  const { runWatch } = await import('./cli-generate.js');
  const { existsSync, readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'rustra-schema-watch-'));
  const config = join(root, 'rustra.json');
  const schema = { packageId: 'app.watch', commands: [] as unknown[] };
  writeFileSync(join(root, 'first.json'), JSON.stringify(schema));
  writeFileSync(join(root, 'second.json'), JSON.stringify(schema));
  writeFileSync(config, JSON.stringify({ schema: 'first.json', output: 'first-output' }));
  const handle = await runWatch(['--config', config]);
  try {
    writeFileSync(config, JSON.stringify({ schema: 'second.json', output: 'second-output' }));
    const types = join(root, 'second-output', 'types.ts');
    await until(() => existsSync(types));
    schema.commands.push({
      name: 'ping',
      inputType: 'PingInput',
      outputType: 'PingOutput',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'string' },
    });
    writeFileSync(join(root, 'second.json'), JSON.stringify(schema));
    await until(() => readFileSync(types, 'utf8').includes('PingOutput'));
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema watch follows a new path even while it is missing or malformed', async () => {
  const { runWatch } = await import('./cli-generate.js');
  const { existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'rustra-schema-recover-'));
  const config = join(root, 'rustra.json');
  const schema = JSON.stringify({ packageId: 'app.watch', commands: [] });
  writeFileSync(join(root, 'first.json'), schema);
  writeFileSync(config, JSON.stringify({ schema: 'first.json', output: 'first-output' }));
  const handle = await runWatch(['--config', config]);
  try {
    for (const name of ['missing', 'malformed']) {
      const path = join(root, `${name}.json`);
      if (name === 'malformed') writeFileSync(path, '{invalid');
      writeFileSync(config, JSON.stringify({ schema: `${name}.json`, output: `${name}-output` }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      writeFileSync(path, schema);
      await until(() => existsSync(join(root, `${name}-output`, 'types.ts')));
    }
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
