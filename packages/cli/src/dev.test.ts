import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWatchLoop,
  parseDevArgs,
  planPipeline,
  detectDirty,
  readDevConfig,
  runOnce,
} from './dev.js';

test('parseDevArgs parses backend dir and app dir', () => {
  const opts = parseDevArgs(['--backend', './backend', '--app', './app']);
  assert.equal(opts.backendDir, './backend');
  assert.equal(opts.appDir, './app');
});

test('parseDevArgs accepts config mode without requiring legacy directories', () => {
  const opts = parseDevArgs(['--config', './rustra.json', '--inspect']);
  assert.equal(opts.configPath, './rustra.json');
  assert.equal(opts.inspect, true);
});

test('parseDevArgs defaults to conventional layout', () => {
  const opts = parseDevArgs([]);
  assert.equal(opts.backendDir, 'backend');
  assert.equal(opts.appDir, 'app');
});

test('readDevConfig rejects a config without a Cargo manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-config-'));
  try {
    const configPath = join(dir, 'rustra.json');
    writeFileSync(configPath, JSON.stringify({ schema: 'schema.json', output: 'generated' }));
    assert.throws(() => readDevConfig(configPath), /rust_manifest_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig rejects unsafe path values before resolving them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-config-'));
  try {
    const configPath = join(dir, 'rustra.json');
    writeFileSync(configPath, JSON.stringify({ schema: `schema\u0000.json`, output: 'generated' }));
    assert.throws(() => readDevConfig(configPath), /safe path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planPipeline reports which stages are dirty after a rust-only change', () => {
  // rust 소스가 schema.json 보다 새면: rust_codegen 필요 → schema 변경 → ts_codegen 필요
  const plan = planPipeline({
    rustNewerThanSchema: true,
    codecsStaleAgainstSchema: false,
  });
  assert.equal(plan.rustBin, true);
  assert.equal(plan.tsCli, true);
});

test('planPipeline skips rust bin when only codecs are stale', () => {
  const plan = planPipeline({ rustNewerThanSchema: false, codecsStaleAgainstSchema: true });
  assert.equal(plan.rustBin, false);
  assert.equal(plan.tsCli, true);
});

test('detectDirty: rust src newer than schema.json → rustNewerThanSchema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-'));
  try {
    const backend = join(dir, 'backend');
    const generated = join(dir, 'app', 'generated');
    mkdirSync(join(backend, 'src'), { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(backend, 'src', 'lib.rs'), 'x');
    const schema = join(generated, 'schema.json');
    writeFileSync(schema, '{}');
    // rust 를 나중으로, schema 를 과거로
    utimesSync(join(backend, 'src', 'lib.rs'), new Date(), new Date('2026-08-16T12:00:01Z'));
    utimesSync(schema, new Date(), new Date('2026-08-16T12:00:00Z'));
    const dirty = detectDirty(backend, generated);
    assert.equal(dirty.rustNewerThanSchema, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDirty: schema newer → not dirty (rust)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-'));
  try {
    const backend = join(dir, 'backend');
    const generated = join(dir, 'app', 'generated');
    mkdirSync(join(backend, 'src'), { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(backend, 'src', 'lib.rs'), 'x');
    const schema = join(generated, 'schema.json');
    writeFileSync(schema, '{}');
    utimesSync(join(backend, 'src', 'lib.rs'), new Date(), new Date('2026-08-16T12:00:00Z'));
    utimesSync(schema, new Date(), new Date('2026-08-16T12:00:05Z'));
    const dirty = detectDirty(backend, generated);
    assert.equal(dirty.rustNewerThanSchema, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce executes dirty stages in order and skips clean ones', async () => {
  const calls: string[] = [];
  await runOnce(
    { rustBin: true, tsCli: false },
    {
      rustBin: async () => void calls.push('rust'),
      tsCli: async () => void calls.push('ts'),
    },
  );
  assert.deepEqual(calls, ['rust']);
});

test('createWatchLoop coalesces changes while a run is in flight', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const loop = createWatchLoop(
    async (reason) => {
      calls.push(reason);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    () => true,
    0,
  );

  const first = loop.run('first', true);
  await Promise.resolve();
  loop.run('second');
  loop.run('third');
  assert.deepEqual(calls, ['first']);
  release();
  await first;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['first', 'queued change']);
  loop.dispose();
});
