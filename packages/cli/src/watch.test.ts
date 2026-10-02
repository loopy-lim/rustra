import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWatch, createSourceWatch, createWatchLoop } from './watch.js';

async function until(predicate: () => boolean): Promise<void> {
  // 100ms 폴링 감시자(F14)가 변화를 전달하기까지의 상한. CI 러너가 모바일 잡과
  // 병렬로 돌면 설정 재해석+코드젠까지 2s를 넘기며 플래키해진다 — dev-parity-wiring
  // 과 같은 10s 상한으로 통일한다(단언은 여전히 "반드시 도달" 그대로).
  const end = Date.now() + 10_000;
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

test('source watch follows a symlinked root and reports original-namespace paths', async () => {
  // 리스크 감사 2026-09-13 #6 — lstat 기반 스냅샷은 심링크 루트를 파일로 기록해
  // 서브트리를 걷지 못했다(이벤트 0). 루트는 realpath 로 걷고, 보고 경로는
  // 사용자가 건 네임스페이스(link 기준)를 유지한다.
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-symlink-'));
  const real = join(root, 'real', 'src');
  mkdirSync(real, { recursive: true });
  const link = join(root, 'link');
  symlinkSync(real, link, 'dir');
  const events: string[] = [];
  const handle = createSourceWatch(link, (path) => events.push(path));
  try {
    const file = join(link, 'lib.rs');
    writeFileSync(file, 'one');
    await until(() => events.includes(file));
    events.length = 0;
    const nestedViaLink = join(link, 'nested.txt');
    writeFileSync(nestedViaLink, 'two');
    await until(() => events.includes(nestedViaLink));
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('source watch follows a retargeted root and stops observing the retired tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-retarget-'));
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  writeFileSync(join(before, 'lib.rs'), 'before');
  writeFileSync(join(after, 'lib.rs'), 'after');
  const link = join(root, 'src');
  symlinkSync(before, link, 'dir');
  const events: string[] = [];
  const handle = createSourceWatch(link, (path) => events.push(path));
  try {
    symlinkSync(after, join(root, 'next'), 'dir');
    renameSync(join(root, 'next'), link);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(events.includes(join(link, 'lib.rs')), 'replacement source tree was not observed');
    events.length = 0;
    writeFileSync(join(after, 'lib.rs'), 'edited replacement');
    await until(() => events.includes(join(link, 'lib.rs')));
    assert.ok(events.every((path) => path.startsWith(link)));
    events.length = 0;
    writeFileSync(join(before, 'lib.rs'), 'edited retired tree');
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(events, []);
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('file watch follows a retargeted directory in the original namespace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-file-watch-retarget-'));
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  writeFileSync(join(before, 'old.json'), 'old');
  writeFileSync(join(after, 'new.json'), 'new');
  const link = join(root, 'schemas');
  symlinkSync(before, link, 'dir');
  const events: Array<[string, string | undefined]> = [];
  const handle = createFileWatch([
    { path: link, onChange: (path, filename) => events.push([path, filename]) },
  ]);
  try {
    symlinkSync(after, join(root, 'next'), 'dir');
    renameSync(join(root, 'next'), link);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      events.some(([path, name]) => path === join(link, 'new.json') && name === 'new.json'),
    );
    events.length = 0;
    writeFileSync(join(after, 'new.json'), 'changed');
    await until(() => events.some(([path]) => path === join(link, 'new.json')));
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('source watch excludes newly created custom outputs but observes adjacent source files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-excluded-'));
  const output = join(root, 'compiled-output');
  const generated = join(root, 'generated');
  const events: string[] = [];
  const handle = createSourceWatch(root, (path) => events.push(path), [output, generated]);
  try {
    mkdirSync(join(output, 'debug'), { recursive: true });
    writeFileSync(join(output, 'debug', 'output.o'), 'build output');
    mkdirSync(generated);
    writeFileSync(join(generated, 'bindings.rs'), 'generated');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(events.length, 0, 'excluded output creation triggered source changes');
    writeFileSync(join(output, 'debug', 'output.o'), 'new build output');
    const source = join(root, 'compiled-output-helper.rs');
    writeFileSync(source, 'relevant source');
    await until(() => events.includes(source));
    assert.deepEqual(events, [source]);
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('source watch excludes traversal through a canonical alias before reading the subtree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-excluded-alias-'));
  const src = join(root, 'src');
  const output = join(src, 'compiled-output');
  mkdirSync(output, { recursive: true });
  const alias = join(root, 'alias');
  symlinkSync(src, alias, 'dir');
  chmodSync(output, 0);
  const events: string[] = [];
  let handle: ReturnType<typeof createSourceWatch> | undefined;
  try {
    handle = createSourceWatch(src, (path) => events.push(path), [join(alias, 'compiled-output')]);
    const source = join(src, 'lib.rs');
    writeFileSync(source, 'source');
    await until(() => events.includes(source));
  } finally {
    handle?.dispose();
    chmodSync(output, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test('source watch refreshes exclusions when the subscribed symlink changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-excluded-retarget-'));
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  const link = join(root, 'src');
  symlinkSync(before, link, 'dir');
  const events: string[] = [];
  const handle = createSourceWatch(link, (path) => events.push(path), [
    join(link, 'compiled-output'),
  ]);
  try {
    symlinkSync(after, join(root, 'next'), 'dir');
    renameSync(join(root, 'next'), link);
    const source = join(link, 'lib.rs');
    writeFileSync(source, 'replacement');
    mkdirSync(join(after, 'compiled-output'));
    writeFileSync(join(after, 'compiled-output', 'output.o'), 'output');
    await until(() => events.includes(source));
    assert.ok(events.every((path) => !path.includes('compiled-output')));
    events.length = 0;
    writeFileSync(join(after, 'compiled-output', 'output.o'), 'changed output');
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(events, []);
  } finally {
    handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('relative source watch paths stay bound to their original working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-watch-relative-'));
  const originalCwd = process.cwd();
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'other'));
  const events: string[] = [];
  let handle: ReturnType<typeof createSourceWatch> | undefined;
  try {
    process.chdir(root);
    const subscribedRoot = join(process.cwd(), 'src');
    handle = createSourceWatch('src', (path) => events.push(path), ['src/compiled-output']);
    process.chdir(join(root, 'other'));
    const source = join(subscribedRoot, 'lib.rs');
    writeFileSync(source, 'source');
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(events.includes(source), 'relative root moved with process.cwd()');
    events.length = 0;
    mkdirSync(join(root, 'src', 'compiled-output'));
    writeFileSync(join(root, 'src', 'compiled-output', 'output.o'), 'output');
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(events, []);
  } finally {
    handle?.dispose();
    process.chdir(originalCwd);
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
