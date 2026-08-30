import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from './cli-init.js';

function withTempDir(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rustra-init-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('runInit refuses to overwrite an existing scaffold and --force replaces it', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    await runInit([project]);
    // 2회째 — 존재하는 파일 차단
    await assert.rejects(() => runInit([project]), /Refusing to overwrite.*Cargo\.toml/);
    await assert.rejects(() => runInit([project]), /--force/);
    // --force로 재생성 통과 + 파일이 여전히 유효한 스캐폴드인지
    await runInit([project, '--force']);
    const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf-8'));
    assert.equal(packageJson.name, 'rustra-app');
    assert.equal(packageJson.scripts.dev, 'rustra dev --config rustra.json');
  });
});

test('runInit does not treat --force-style unknown flags as positionals', async () => {
  await withTempDir(async (root) => {
    // 오타 플래그는 positional로 흡수되지 않고 명확히 에러난다 (arg-parser 통일 계약)
    await assert.rejects(
      () => runInit([join(root, 'x'), '--forcee']),
      /Unknown init option: --forcee[\s\S]*--force/,
    );
  });
});

test('runInit rejects zero or multiple project directories', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(() => runInit([]), /Provide one project directory/);
    await assert.rejects(
      () => runInit([join(root, 'a'), join(root, 'b')]),
      /Provide one project directory/,
    );
  });
});

test('runInit --help exits without creating anything', async () => {
  await withTempDir(async (root) => {
    await runInit(['--help']);
    await runInit(['-h']);
    assert.equal(readdirSync(root).length, 0);
  });
});

test('existing foreign files unrelated to the scaffold do not block init', async () => {
  await withTempDir(async (root) => {
    const project = join(root, 'app');
    writeFileSync(join(root, 'unrelated.txt'), 'keep me');
    await runInit([project]);
    const fs = await import('node:fs');
    assert.equal(fs.readFileSync(join(root, 'unrelated.txt'), 'utf-8'), 'keep me');
    assert.ok(fs.existsSync(join(project, 'Cargo.toml')));
  });
});
