#!/usr/bin/env bun
/**
 * hot-core loop bench — dylib 핫스왑 dev 루프(수정 → 발행 → 스왑) 실측 하니스.
 *
 * 측정 대상(`rustra dev` dev.target:"dylib" + RUSTRA_HOT_CORE 호스트):
 *
 *   (a) examples/calculator/src/lib.rs 의 add_numbers 본문을 **스키마 불변**으로
 *       토글한다(`+ std::hint::black_box(0)` 추가/제거). black_box 는 상수 접기를
 *       막아 dylib 바이트가 실질 변경됨을 보장하고, 동작(2+3=5)과 스키마는 불변 —
 *       parity 게이트가 통과해야 하는 정상 경로다.
 *   (b) `rustra dev`(watch)가 codegen → cdylib 빌드 → parity 게이트 → `-hot-live`
 *       원자 발행까지 끝내는 시점을 live 아티팩트 inode+sha256 변화로 감지한다.
 *   (c) 호스트가 sha256 폴링(300ms)으로 스왑한 시점을 프로브의 stdout
 *       "PROBE SWAP <old> -> <new>" 라인 도착으로 감지한다.
 *
 * 호스트: examples/hot-core-probe 바이너리 `--watch` 모드. tauri-calculator 의
 * 핫 모드(tauri.conf.json visible window, 수정 금지)를 GUI 없이 대체하며, 감시
 * 스왑은 같은 프리미티브(crates/rustra hot_core_watch::spawn_dylib_watch, 300ms
 * sha256 폴링)를 공유하고 초기 코어를 live 경로로 연다(프로브 소스 계약).
 *
 * 결과는 stdout 으로만 출력한다(사이클 표 + 요약 + JSON 블록). 측정 후
 * examples/calculator 소스를 시작 시점 바이트로 복원하고, 새로 생긴
 * `-hot-<n>` 스왑 카피(target/)만 치운다. 코드젠 generated/ 는 토글이 스키마
 * 불변이므로 바이트 동일해야 하며, 하니스가 시작/종료 해시로 검증한다.
 *
 * 사용법:
 *   bun scripts/hot-core-loop-bench.mjs                 # 워밍업 2 + 측정 20사이클
 *   BENCH_CYCLES=7 BENCH_WARMUP=2 bun scripts/hot-core-loop-bench.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 측정 설정 ────────────────────────────────────────────────────────────────
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
const MEASURED = Number(process.env.BENCH_CYCLES ?? 20);
const POLL_MS = Number(process.env.BENCH_POLL_MS ?? 10);
const PUBLISH_TIMEOUT_MS = 240_000;
const SWAP_TIMEOUT_MS = 90_000;
const PROBE_WATCH_SECONDS = 900;

// 기본 config 는 예제 전용 rustra.hot.json 이다. 이 브랜치에서는 그 config 의
// node/bun 섹션이 appRoot(examples/tauri-calculator)에서 Cargo.toml 을 찾지 못해
// codegen 이 실패하는 기존 버그가 있다("Host setup found 0 Cargo packages") —
// BENCH_CONFIG 로 동일 설정을 절대경로+명시 rustManifest 로 표현한 임시 config
// (/tmp/rustra-hot-bench/rustra-hot-bench.json)를 건네면 같은 파이프라인이
// 동작한다(생성 바이트 동일성은 하니스가 지문으로 검증한다).
const configPath = resolve(
  process.env.BENCH_CONFIG ?? join(root, 'examples/tauri-calculator/rustra.hot.json'),
);
const cliEntry = join(root, 'packages/cli/dist/index.js');
const probeBin = join(root, 'target/debug/rustra-hot-core-probe');
const sourcePath = join(root, 'examples/calculator/src/lib.rs');
const generatedDir = join(root, 'examples/calculator/generated');
const targetDebug = join(root, 'target/debug');
const expectedLive = join(targetDebug, 'librustra_calculator_example-hot-live.dylib');

// ── 스키마 불변 토글 — add_numbers 본문만, 시그니처·타입·스키마 무변경 ───────
const ORIGINAL_BLOCK = `pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}`;
const TOGGLED_BLOCK = `pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b + std::hint::black_box(0),
    })
}`;

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const now = () => performance.now();

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 스트림을 줄 단위로 분해해 도착 시점(ms)과 함께 콜백에 넘긴다. */
function onLine(stream, callback) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      callback(line, now());
    }
  });
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolveWith, rejectWith) => {
    const timer = setTimeout(() => rejectWith(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveWith(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectWith(error);
      },
    );
  });
}

function machineInfo() {
  const sysctl = (name) => {
    const result = spawnSync('sysctl', ['-n', name], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const version = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim().split('\n')[0] : undefined;
  };
  const memsize = Number(sysctl('hw.memsize') ?? 0);
  return {
    model: sysctl('hw.model'),
    chip: sysctl('machdep.cpu.brand_string'),
    memoryGiB: memsize > 0 ? Math.round(memsize / 2 ** 30) : undefined,
    osVersion: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout?.trim(),
    arch: spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout?.trim(),
    cargo: version('cargo', ['--version']),
    rustc: version('rustc', ['--version']),
    bun: version('bun', ['--version']),
  };
}

/** generated/ 전체의 콘텐츠 해시 지문 — 벤치 전후 바이트 동일성 검증용. */
function generatedFingerprint() {
  const entries = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else entries[`${prefix}${entry.name}`] = sha256File(path);
    }
  };
  walk(generatedDir, '');
  return entries;
}

/** target/debug 의 기존 `-hot-<n>` 스왑 카피 목록(정리는 새 것만). */
function hotSwapCopies() {
  return new Set(
    readdirSync(targetDebug).filter((name) =>
      /^librustra_calculator_example-hot-\d+\.dylib$/.test(name),
    ),
  );
}

// ── 프리플라이트 ─────────────────────────────────────────────────────────────
console.error('[bench] 1/6 preflight — build probe binary and CLI dist');
runSync('cargo', ['build', '-q', '-p', 'rustra-hot-core-probe']);
// 측정되는 파이프라인 코드가 현재 소스와 일치하도록 dist 를 항상 재빌드한다.
runSync('bun', ['run', '--cwd', 'packages/cli', 'build']);
if (!existsSync(cliEntry) || !existsSync(probeBin) || !existsSync(configPath)) {
  throw new Error(`preflight failed: ${cliEntry} / ${probeBin} / ${configPath}`);
}

const originalSource = readFileSync(sourcePath, 'utf8');
if (originalSource.includes('std::hint::black_box(0)')) {
  throw new Error(
    'examples/calculator/src/lib.rs is already toggled — restore it to the pristine state first',
  );
}
if (!originalSource.includes(ORIGINAL_BLOCK)) {
  throw new Error('add_numbers pristine block not found — the toggle anchor does not match');
}
const fingerprintBefore = generatedFingerprint();
const copiesBefore = hotSwapCopies();
const envInfo = machineInfo();

// ── 프로세스 관리 ────────────────────────────────────────────────────────────
let dev = null;
let probe = null;
let benchDone = false;

function killChild(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveKill) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveKill();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveKill();
    });
    child.kill('SIGTERM');
  });
}

function restoreSource() {
  if (readFileSync(sourcePath, 'utf8') !== originalSource) {
    writeFileSync(sourcePath, originalSource);
    console.error('[bench] source restored to the pristine bytes');
  }
}

async function shutdown() {
  await killChild(probe);
  await killChild(dev);
  restoreSource();
  // 벤치가 만든 새 스왑 카피만 치운다(시작 전부터 있던 파일은 그대로 둔다).
  for (const name of hotSwapCopies()) {
    if (!copiesBefore.has(name)) spawnSync('rm', ['-f', join(targetDebug, name)]);
  }
}

// SIGINT(터미널 ^C)뿐 아니라 SIGTERM/SIGHUP(종료 훅, CI 타임아웃 kill, 터미널
// 세션 종료)에서도 복원한다 — 이 핸들러가 없으면 토글된 추적 소스가 작업
// 트리에 남는다(SIGKILL 만 어쩔 수 없이 못 잡는다 — 프리플라이트가 걸러준다).
const shutdownForSignal = async (code) => {
  if (!benchDone) {
    console.error('\n[bench] interrupted — restoring source and killing children');
    await shutdown();
  }
  process.exit(code);
};
process.on('SIGINT', () => shutdownForSignal(130));
process.on('SIGTERM', () => shutdownForSignal(143));
process.on('SIGHUP', () => shutdownForSignal(129));

try {
  // ── `rustra dev` 기동 (watch 모드, 초기 codegen+빌드+발행 대기) ──────────────
  console.error('[bench] 2/6 starting `rustra dev` (dylib target) and waiting for initial publish');
  const schemaDones = [];
  const dylibDones = [];
  const devIssues = [];
  let livePath;
  let sawPublishLine = false;
  let sawWatchingLine = false;
  let resolveDevReady;
  const devReady = new Promise((resolveReady) => {
    resolveDevReady = resolveReady;
  });
  const tryResolveDevReady = () => {
    if (sawPublishLine && sawWatchingLine) resolveDevReady();
  };

  dev = spawn('bun', [cliEntry, 'dev', '--config', configPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onLine(dev.stdout, (line) => {
    const schemaDone = line.match(/✓ Rust schema generation .* done in ([0-9.]+)s/);
    if (schemaDone) {
      schemaDones.push(Number(schemaDone[1]));
      return;
    }
    if (!sawPublishLine) {
      const published = line.match(/launch the host with RUSTRA_HOT_CORE=(\S+)/);
      if (published) {
        sawPublishLine = true;
        livePath = published[1];
        tryResolveDevReady();
        return;
      }
    }
    if (line.includes('watching') && line.includes('for changes')) {
      sawWatchingLine = true;
      tryResolveDevReady();
    }
  });
  onLine(dev.stderr, (line) => {
    const dylibDone = line.match(/✓ dylib core build .* done in ([0-9.]+)s/);
    if (dylibDone) {
      dylibDones.push(Number(dylibDone[1]));
      return;
    }
    if (line.includes('[dev] regeneration failed')) devIssues.push(line);
    if (/error\[|error:|failed to/i.test(line) && !line.includes('still running')) {
      devIssues.push(line);
    }
  });
  dev.once('exit', (code, signal) => {
    if (!benchDone) devIssues.push(`[dev] exited early code=${code} signal=${signal}`);
  });

  await withTimeout(
    devReady,
    PUBLISH_TIMEOUT_MS,
    `rustra dev initial run timed out. issues: ${devIssues.join(' | ')}`,
  );
  if (livePath === undefined) livePath = expectedLive;
  if (resolve(livePath) !== resolve(expectedLive)) {
    throw new Error(`live artifact path mismatch: ${livePath} != ${expectedLive}`);
  }
  if (devIssues.length > 0) {
    throw new Error(`rustra dev reported issues during startup: ${devIssues.join(' | ')}`);
  }
  // 초기 런(콜드/준콜드)의 cargo 단계 시간은 기록해두고 사이클 큐에서 배제한다.
  const initialBuild = {
    schemaGenS: schemaDones.shift() ?? null,
    dylibBuildS: dylibDones.shift() ?? null,
  };
  console.error(
    `[bench]    initial publish done — live=${livePath} ` +
      `(schema gen ${initialBuild.schemaGenS}s, dylib build ${initialBuild.dylibBuildS}s)`,
  );

  // ── 호스트(프로브 --watch) 기동 ──────────────────────────────────────────────
  console.error('[bench] 3/6 starting hot-core host (probe --watch) on the live artifact');
  let resolveProbeReady;
  const probeReady = new Promise((resolveReady) => {
    resolveProbeReady = resolveReady;
  });
  const swapWaiters = [];
  let probeFailure = null;

  probe = spawn(probeBin, [livePath, '--watch', String(PROBE_WATCH_SECONDS)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onLine(probe.stdout, (line, at) => {
    if (line.startsWith('PROBE CONTRACT')) {
      resolveProbeReady();
      return;
    }
    if (line.startsWith('PROBE SWAP FAILED')) {
      probeFailure = line;
      const waiter = swapWaiters.shift();
      if (waiter) waiter.reject(new Error(line));
      return;
    }
    if (line.startsWith('PROBE SWAP ')) {
      const waiter = swapWaiters.shift();
      if (waiter) waiter.resolve(at);
    }
  });
  onLine(probe.stderr, (line) => {
    if (!line.startsWith('PROBE FAIL')) return;
    probeFailure = line;
    const waiter = swapWaiters.shift();
    if (waiter) waiter.reject(new Error(line));
  });
  probe.once('exit', (code, signal) => {
    if (!benchDone && code !== 0 && code !== null) {
      probeFailure = `probe exited code=${code} signal=${signal}`;
    }
  });
  await withTimeout(probeReady, 120_000, 'probe did not report PROBE CONTRACT in time');
  // run_watch 의 두 번째 open + 감시 스레드 기준 해시 확정 대기.
  await new Promise((resolveSettle) => setTimeout(resolveSettle, 1_500));
  if (probeFailure) throw new Error(`host failed during startup: ${probeFailure}`);
  console.error('[bench]    host is watching — starting cycles');

  // ── 사이클 실행 ──────────────────────────────────────────────────────────────
  function waitPublish(baseline, timeoutMs) {
    return new Promise((resolvePublish, rejectPublish) => {
      const startedAt = now();
      const timer = setInterval(() => {
        let stat;
        try {
          stat = statSync(livePath);
        } catch {
          return; // rename 순간 — 다음 폴링에서 재시도
        }
        if (stat.ino !== baseline.ino) {
          const sha = sha256File(livePath);
          if (sha !== baseline.sha) {
            clearInterval(timer);
            resolvePublish({ at: now(), sha });
            return;
          }
        }
        if (now() - startedAt > timeoutMs) {
          clearInterval(timer);
          rejectPublish(new Error('publish wait timed out — live artifact never changed'));
        }
      }, POLL_MS);
    });
  }

  function waitSwap(timeoutMs) {
    return new Promise((resolveSwap, rejectSwap) => {
      const timeout = setTimeout(() => {
        const index = swapWaiters.indexOf(entry);
        if (index !== -1) swapWaiters.splice(index, 1);
        rejectSwap(new Error('swap wait timed out — host never reported PROBE SWAP'));
      }, timeoutMs);
      const entry = {
        resolve: (at) => {
          clearTimeout(timeout);
          resolveSwap(at);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectSwap(error);
        },
      };
      swapWaiters.push(entry);
    });
  }

  function applyToggle() {
    const current = readFileSync(sourcePath, 'utf8');
    const next = current.includes('std::hint::black_box(0)')
      ? current.replace(TOGGLED_BLOCK, ORIGINAL_BLOCK)
      : current.replace(ORIGINAL_BLOCK, TOGGLED_BLOCK);
    if (next === current) throw new Error('source toggle did not apply — anchor mismatch');
    writeFileSync(sourcePath, next);
  }

  const cycles = [];

  console.error(
    `[bench] 4/6 running ${WARMUP} warmup + ${MEASURED} measured cycles ` +
      `(sequential, no concurrent builds)`,
  );
  for (let index = 0; index < WARMUP + MEASURED; index += 1) {
    const isWarmup = index < WARMUP;
    const label = isWarmup
      ? `warmup ${index + 1}/${WARMUP}`
      : `cycle ${index - WARMUP + 1}/${MEASURED}`;
    // 이전 사이클의 발행물이 감시 기준선으로 안정화될 시간을 둔다.
    const baselineStat = statSync(livePath);
    const baselineSha = sha256File(livePath);

    applyToggle();
    const tEdit = now();

    const publish = await waitPublish(
      { ino: baselineStat.ino, sha: baselineSha },
      PUBLISH_TIMEOUT_MS,
    );
    const tSwap = await waitSwap(SWAP_TIMEOUT_MS);

    // cargo 단계 시간 귀속 — 파이프라인이 순차이므로 각 큐의 머리 항목이 이번 사이클.
    const schemaGenS = schemaDones.shift() ?? null;
    const dylibBuildS = dylibDones.shift() ?? null;

    const record = {
      cycle: index + 1,
      phase: isWarmup ? 'warmup' : 'measured',
      publishMs: Math.round(publish.at - tEdit),
      swapMs: Math.round(tSwap - publish.at),
      totalMs: Math.round(tSwap - tEdit),
      schemaGenS,
      dylibBuildS,
      liveSha12: publish.sha.slice(0, 12),
    };
    cycles.push(record);
    if (probeFailure) throw new Error(`host failure after ${label}: ${probeFailure}`);
    console.error(
      `[bench]    ${label}: publish ${record.publishMs}ms, swap ${record.swapMs}ms, ` +
        `total ${record.totalMs}ms (cargo schema ${schemaGenS ?? '?'}s, dylib ${dylibBuildS ?? '?'}s)`,
    );

    // 사이클 사이 여유 — dev 루프 재무장과 스왑 카피 정리에 겹침이 없도록.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 400));
  }

  // ── 정리 및 복원 ─────────────────────────────────────────────────────────────
  console.error('[bench] 5/6 stopping processes and restoring the workspace');
  benchDone = true;
  await shutdown();

  const fingerprintAfter = generatedFingerprint();
  const generatedIdentical = JSON.stringify(fingerprintBefore) === JSON.stringify(fingerprintAfter);
  const gitStatus =
    spawnSync('git', ['status', '--porcelain', 'examples/calculator'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout?.trim() ?? '';
  if (!generatedIdentical) {
    console.error(
      '[bench] WARNING — generated/ bytes changed: ' +
        JSON.stringify({ before: fingerprintBefore, after: fingerprintAfter }),
    );
  }
  if (gitStatus.length > 0) {
    console.error(`[bench] WARNING — examples/calculator not clean after restore:\n${gitStatus}`);
  }

  // ── 요약 ─────────────────────────────────────────────────────────────────────
  console.error('[bench] 6/6 summary');
  const measured = cycles.filter((cycle) => cycle.phase === 'measured');
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const nearestRank = (ratio) =>
      sorted[Math.min(sorted.length, Math.ceil(ratio * sorted.length)) - 1];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      min: sorted[0],
      p50: nearestRank(0.5),
      p95: nearestRank(0.95),
      max: sorted[sorted.length - 1],
      mean: Math.round(mean * 10) / 10,
    };
  };
  const summary = {
    publishMs: stats(measured.map((cycle) => cycle.publishMs)),
    swapMs: stats(measured.map((cycle) => cycle.swapMs)),
    totalMs: stats(measured.map((cycle) => cycle.totalMs)),
  };

  const pad = (value, width) => String(value).padStart(width);
  console.log('');
  console.log('=== hot-core loop bench — per-cycle raw data (ms) ===');
  console.log(
    `${'cycle'.padEnd(8)} ${'phase'.padEnd(9)} ${'publish'.padStart(8)} ` +
      `${'swap'.padStart(7)} ${'total'.padStart(7)} ${'schemaGen'.padStart(10)} ` +
      `${'dylibBuild'.padStart(11)}  live-sha12`,
  );
  for (const cycle of cycles) {
    console.log(
      `${pad(cycle.cycle, 8)} ${cycle.phase.padEnd(9)} ${pad(cycle.publishMs, 8)} ` +
        `${pad(cycle.swapMs, 7)} ${pad(cycle.totalMs, 7)} ` +
        `${pad(cycle.schemaGenS === null ? '-' : `${cycle.schemaGenS}s`, 10)} ` +
        `${pad(cycle.dylibBuildS === null ? '-' : `${cycle.dylibBuildS}s`, 11)}  ${cycle.liveSha12}`,
    );
  }
  console.log('');
  console.log(`=== summary (measured n=${measured.length}, warmup ${WARMUP} excluded) ===`);
  for (const key of ['publishMs', 'swapMs', 'totalMs']) {
    const stat = summary[key];
    console.log(
      `${key.padEnd(10)} min=${pad(stat.min, 5)} p50=${pad(stat.p50, 5)} p95=${pad(stat.p95, 5)} ` +
        `max=${pad(stat.max, 5)} mean=${pad(stat.mean, 6)}`,
    );
  }
  console.log(
    `\ninitial build (pre-warmup): schema gen ${initialBuild.schemaGenS}s, dylib build ${initialBuild.dylibBuildS}s`,
  );
  console.log(`generated/ byte-identical after bench: ${generatedIdentical}`);
  console.log(
    `git status --porcelain examples/calculator: ${gitStatus.length === 0 ? '(clean)' : gitStatus}`,
  );
  console.log('');
  console.log('=== JSON (machine-readable) ===');
  console.log(
    JSON.stringify(
      {
        env: envInfo,
        config: {
          warmup: WARMUP,
          measured: MEASURED,
          pollMsHost: 300,
          pollMsHarness: POLL_MS,
          liveArtifact: livePath,
          benchConfig: configPath,
          mutation: 'add_numbers body + std::hint::black_box(0) toggle (schema-invariant)',
          host: 'examples/hot-core-probe --watch (spawn_dylib_watch, 300ms sha256 polling)',
          initialBuild,
        },
        cycles,
        summary,
        integrity: {
          generatedByteIdentical: generatedIdentical,
          gitStatusExamplesCalculator: gitStatus,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `[bench] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  benchDone = true;
  await shutdown();
  process.exit(1);
}
