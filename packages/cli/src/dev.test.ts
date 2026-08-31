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
  runDev,
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

test('runDev fails fast instead of silently watching a missing layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-layout-'));
  try {
    await assert.rejects(
      () => runDev(['--backend', join(dir, 'backend'), '--app', join(dir, 'app')]),
      /requires backend/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runDev reload orchestration (Task A1) ────────────────────────────────────
//
// runDev 의 파이프라인은 실제 cargo/node 를 spawn 하므로, 훅 계약은 watch 루프의
// perform 대신 미리 기록된 dirty 상태를 시드해 검증한다: backend/src 를 schema
// 보다 새로 만들면 initial run 이 rustBin+tsCli 를 태운다(cargo 미설정 환경에서는
// 재생성이 실패 → reload 방출이 억제되는 것까지 함께 확인한다).

function seedLegacyLayout(dir: string): { backend: string; app: string } {
  const backend = join(dir, 'backend');
  const app = join(dir, 'app');
  mkdirSync(join(backend, 'src'), { recursive: true });
  mkdirSync(join(app, 'generated'), { recursive: true });
  writeFileSync(join(backend, 'src', 'lib.rs'), 'fn main() {}');
  writeFileSync(join(app, 'generated', 'schema.json'), '{}');
  // rust 를 새로, schema 를 과거로 — initial run 이 dirty 가 되게 한다.
  utimesSync(join(backend, 'src', 'lib.rs'), new Date(), new Date('2026-08-16T12:00:01Z'));
  utimesSync(join(app, 'generated', 'schema.json'), new Date(), new Date('2026-08-16T12:00:00Z'));
  return { backend, app };
}

test('runDev suppresses the reload hook when regeneration fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-reload-'));
  try {
    seedLegacyLayout(dir);
    process.env.RUSTRA_CLI = process.execPath; // tsCli 용 스텁 — rustBin 이 먼저 실패한다.
    const reloads: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      const handle = await runDev(['--backend', join(dir, 'backend'), '--app', join(dir, 'app')]);
      handle.onReload((reason) => void reloads.push(reason));
      // 이미 initial run 이 끝났고 rustBin(cargo)은 실패했으므로 reload 는 없다.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(reloads, [], 'failed regeneration must not emit reload');
      assert.ok(errors.some((line) => line.includes('[dev] regeneration failed')));
      handle.dispose();
    } finally {
      console.error = originalError;
      delete process.env.RUSTRA_CLI;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── reload hook (Task A1) — codegen 성공 후 엔진 재초기화 트리거 ─────────────

test('createWatchLoop fires reload hooks after a successful perform', async () => {
  const reloads: string[] = [];
  const loop = createWatchLoop(
    async () => {},
    () => true,
    0,
  );
  loop.onReload((reason) => void reloads.push(reason));
  await loop.run('rust change', true);
  assert.deepEqual(reloads, ['rust change']);
  loop.dispose();
});

test('createWatchLoop reload hook errors are logged and do not break the loop', async () => {
  const reloads: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => errors.push(String(line));
  try {
    const runs: string[] = [];
    const loop = createWatchLoop(
      async (reason) => void runs.push(reason),
      () => true,
      0,
    );
    loop.onReload(() => {
      throw new Error('host engine exploded');
    });
    loop.onReload((reason) => void reloads.push(reason));
    await loop.run('first', true);
    // 두 번째 훅은 첫 훅이 던져도 여전히 호출된다 — 격리 계약.
    assert.deepEqual(reloads, ['first']);
    assert.ok(errors.some((line) => line.includes('[dev] reload failed: host engine exploded')));
    // 루프 생존 증명 — 이후 run 이 정상 수행된다.
    await loop.run('second', true);
    assert.deepEqual(runs, ['first', 'second']);
    assert.deepEqual(reloads, ['first', 'second']);
    loop.dispose();
  } finally {
    console.error = originalError;
  }
});
