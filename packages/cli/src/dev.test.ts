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

test('createWatchLoop does not fire reload hooks when shouldRun skips the perform', async () => {
  // 민감도 계약: reload 는 perform 이 실제 실행된 뒤에만 방출된다. 비강제 run 이
  // shouldRun=false 로 perform 을 건너뛰면 reload 도 없어야 한다 — emitReload 가
  // 게이트 밖으로 나가는 회귀를 이 대조 구조가 잡는다(sabotage 검증됨).
  let dirty = false;
  const loop = createWatchLoop(
    async () => {},
    () => dirty,
    0,
  );
  const reloads: string[] = [];
  loop.onReload((reason) => void reloads.push(reason));
  await loop.run('clean check'); // 비강제 — shouldRun=false → perform 스킵.
  assert.deepEqual(reloads, [], 'skipped perform must not emit reload');
  // 대조: 같은 루프에서 shouldRun 이 참이 되면 정확히 한 번 방출된다.
  dirty = true;
  await loop.run('dirty check');
  assert.deepEqual(reloads, ['dirty check'], 'performed run emits exactly one reload');
  loop.dispose();
});

test('runDev logs "clean — nothing to do" and skips codegen on an up-to-date tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-clean-'));
  try {
    // 완전한 clean 플랜을 시드한다: rust 소스는 schema 보다 과거, codecs 는 schema
    // 보다 새로 — perform 이 '[dev] clean — nothing to do' 로 조기 반환하는 경로.
    // (runDev 수준에서 reload 를 관찰할 수 없는 이유: onReload 는 initial 강제 run
    // 이 끝난 뒤에 등록되고 이후 run 이 결정적으로 발생하지 않는다. reload 방출
    // 게이트의 민감한 검증은 위 createWatchLoop 단위 테스트가 담당한다.)
    const backend = join(dir, 'backend');
    const app = join(dir, 'app');
    mkdirSync(join(backend, 'src'), { recursive: true });
    mkdirSync(join(app, 'generated'), { recursive: true });
    writeFileSync(join(backend, 'src', 'lib.rs'), 'fn main() {}');
    const schema = join(app, 'generated', 'schema.json');
    writeFileSync(schema, '{}');
    writeFileSync(join(app, 'generated', 'rkyv-codecs.ts'), '');
    utimesSync(
      join(backend, 'src', 'lib.rs'),
      new Date('2026-08-16T12:00:00Z'),
      new Date('2026-08-16T12:00:00Z'),
    );
    utimesSync(schema, new Date('2026-08-16T12:00:05Z'), new Date('2026-08-16T12:00:05Z'));
    utimesSync(
      join(app, 'generated', 'rkyv-codecs.ts'),
      new Date('2026-08-16T12:00:10Z'),
      new Date('2026-08-16T12:00:10Z'),
    );
    process.env.RUSTRA_CLI = process.execPath;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: unknown) => logs.push(String(line));
    try {
      const handle = await runDev(['--backend', backend, '--app', app]);
      assert.ok(logs.some((line) => line.includes('[dev] clean — nothing to do')));
      assert.ok(
        !logs.some((line) => line.includes('regenerated')),
        'clean tree must not run codegen',
      );
      handle.dispose();
    } finally {
      console.log = originalLog;
      delete process.env.RUSTRA_CLI;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── parity gate wiring (Task A2) — dev.target=wasm + parityGate ─────────────

test('readDevConfig exposes wasm dev settings including parityGate default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-parity-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        reactNative: { moduleDir: 'modules' },
        dev: { target: 'wasm', wasm: { engine: 'wasm3' } },
      }),
    );
    const config = readDevConfig(configPath);
    assert.equal(config.dev?.target, 'wasm');
    assert.equal(config.dev?.wasm?.parityGate, true, 'parityGate defaults to true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevConfig honors an explicit parityGate false and native default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-parity-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
    const configPath = join(dir, 'rustra.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema: 'schema.json',
        output: 'generated',
        reactNative: { moduleDir: 'modules' },
        dev: { target: 'wasm', wasm: { engine: 'wasm3', parityGate: false } },
      }),
    );
    const off = readDevConfig(configPath);
    assert.equal(off.dev?.wasm?.parityGate, false);

    const plainPath = join(dir, 'plain.json');
    writeFileSync(plainPath, JSON.stringify({ schema: 'schema.json', output: 'generated' }));
    const plain = readDevConfig(plainPath);
    assert.equal(plain.dev, undefined, 'no dev section → native defaults, no gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWatchLoop parity orchestration rejects a drifted reload and keeps the old engine state', async () => {
  // parity gate 오케스트레이션 계약: reload 훅 안에서 gate.verify() 가 실패하면
  // reload 는 거부되고(로드), 루프는 살아남은다. 훅 에러 격리 계약(A1)과 동일한
  // 구조 — 게이트 거부가 루프를 죽이지 않는다.
  const { createParityGate } = await import('./parity-gate.js');
  let hashState = 'h1';
  const gate = createParityGate({
    capture: async () => ({ contractHash: hashState, golden: 'aa' }),
  });
  await gate.arm();

  const reloads: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => errors.push(String(line));
  try {
    const loop = createWatchLoop(
      async () => {
        // perform: 코드젠 후 "새 엔진"이 계약을 바꿔버린 시나리오.
        hashState = 'h2';
      },
      () => true,
      0,
    );
    loop.onReload(async () => {
      const verdict = await gate.verify();
      if (!verdict.ok) throw new Error(verdict.reason);
      reloads.push('applied');
    });
    await loop.run('rust change', true);
    // 루프 생존의 실제 증거: run() 이 던지지 않고 정상 반환됐고(훅 에러 격리),
    // 그 왕복에서 reload 는 방출되지 않았다. hashState 는 생존 증거가 아니라
    // "perform 이 돌았다"의 보조 관찰일 뿐이다.
    assert.deepEqual(
      reloads,
      [],
      'drifted reload must be rejected; an empty reload list plus run() returning ' +
        'normally is the evidence the loop survived the rejection (A1 isolation)',
    );
    assert.ok(
      errors.some((line) => line.includes('contract hash drift')),
      'rejection must be loud',
    );
    assert.equal(hashState, 'h2', 'perform ran before the hook rejected');
    loop.dispose();
  } finally {
    console.error = originalError;
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
