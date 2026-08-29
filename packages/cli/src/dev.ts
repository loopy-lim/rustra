/**
 * `rustra dev` — Rust 소스 감시 + dual-path codegen 자동 루프.
 *
 * 기존 `rustra generate --watch` 는 schema.json 변경만 감시하는데 schema.json 은
 * Rust bin 을 실행해야 갱신된다. `rustra dev` 는 backend/src 변경을 감지해
 * (1) Rust bin → types/commands/contract/schema, (2) TS CLI → rkyv-codecs/registry
 * 를 순서대로 재실행한다 (dual-path codegen).
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { spawnInherit } from './process.js';
import { findCargoManifest } from './cargo.js';
import { readConfigSync } from './config.js';

export interface DevOptions {
  configPath?: string;
  backendDir: string;
  appDir: string;
  inspect: boolean;
}

export function parseDevArgs(args: string[]): DevOptions {
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    configPath: get('config'),
    backendDir: get('backend') ?? 'backend',
    appDir: get('app') ?? 'app',
    inspect: args.includes('--inspect'),
  };
}

export interface PipelinePlan {
  rustBin: boolean;
  tsCli: boolean;
}

export function planPipeline(dirty: {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
}): PipelinePlan {
  return {
    // rust 소스가 새면 schema 재생성 필요 → schema 가 바뀌면 ts cli 재생성 필요
    rustBin: dirty.rustNewerThanSchema,
    tsCli: dirty.rustNewerThanSchema || dirty.codecsStaleAgainstSchema,
  };
}

/** dir 트리에서 가장 최신 mtime (재귀, node_modules/target/dist 제외). */
function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(p));
    } else {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

/** codegen 재실행 판정에 필요한 stale 상태. */
export function detectDirty(
  backendDir: string,
  generatedDir: string,
): {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
} {
  const schemaPath = join(generatedDir, 'schema.json');
  const schemaMtime = existsSync(schemaPath) ? statSync(schemaPath).mtimeMs : 0;
  const rustNewest = newestMtime(join(backendDir, 'src'));
  const codecsNewest = Math.max(
    ...['rkyv-codecs.ts', 'rkyv-registry.ts'].map((f) => {
      const p = join(generatedDir, f);
      return existsSync(p) ? statSync(p).mtimeMs : 0;
    }),
  );
  return {
    rustNewerThanSchema: rustNewest > schemaMtime,
    codecsStaleAgainstSchema: schemaMtime > codecsNewest,
  };
}

/** config 모드용 stale 판정. schema와 codec 출력 위치가 달라도 동작한다. */
export function detectConfigDirty(
  manifestDir: string,
  schemaPath: string,
  outputPath: string,
): boolean {
  const schemaMtime = existsSync(schemaPath) ? statSync(schemaPath).mtimeMs : 0;
  const rustNewest = newestMtime(join(manifestDir, 'src'));
  const generatedNewest = newestMtime(outputPath);
  return rustNewest > schemaMtime || schemaMtime > generatedNewest;
}

export interface StageRunners {
  rustBin: () => Promise<void>;
  tsCli: () => Promise<void>;
}

export type WatchLoop = {
  run(reason: string, force?: boolean): Promise<void>;
  schedule(reason: string): void;
  dispose(): void;
};

/**
 * 파일 감시 루프의 공통 상태 머신.
 *
 * 한 번에 하나의 pipeline 만 실행하고, 실행 중 들어온 여러 파일 이벤트는
 * 하나의 queued run 으로 합친다. `force` 는 최초 실행처럼 dirty 판정을
 * 건너뛰어야 하는 경우에만 사용한다.
 */
export function createWatchLoop(
  perform: (reason: string) => Promise<void>,
  shouldRun: () => boolean | Promise<boolean>,
  debounceMs = 300,
): WatchLoop {
  let running = false;
  let queued = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let schedule: (reason: string) => void;
  const run = async (reason: string, force = false): Promise<void> => {
    if (disposed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      if (force || (await shouldRun())) await perform(reason);
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        schedule('queued change');
      }
    }
  };

  schedule = (reason: string) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run(reason);
    }, debounceMs);
  };

  return {
    run,
    schedule,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** plan 이 지정한 스테이지만 순서대로 실행 (rust → ts). */
export async function runOnce(plan: PipelinePlan, runners: StageRunners): Promise<void> {
  if (plan.rustBin) await runners.rustBin();
  if (plan.tsCli) await runners.tsCli();
}

export function readDevConfig(configPath: string): {
  root: string;
  schemaPath: string;
  outputPath: string;
  manifestPath: string;
} {
  const path = resolve(configPath);
  const root = dirname(path);
  const config = readConfigSync(path);
  let manifestPath = config.codegen?.rustManifest
    ? resolve(root, config.codegen.rustManifest)
    : undefined;
  if (!config.codegen?.rustManifest) {
    manifestPath = findCargoManifest(root);
  }
  if (!manifestPath || !existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('codegen.rust_manifest_missing: set codegen.rustManifest in rustra.json');
  }
  return {
    root,
    schemaPath: resolve(root, config.schema),
    outputPath: resolve(root, config.output),
    manifestPath,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function sourceDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'target' || entry.name === 'node_modules') continue;
    directories.push(...sourceDirectories(join(root, entry.name)));
  }
  return directories;
}

/** legacy 감시 모드에서만 쓰는 repo-local CLI 위치 탐색. */
function findRepoCli(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    dir = dirname(dir);
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function runDev(args: string[]): Promise<void> {
  const opts = parseDevArgs(args);
  if (opts.configPath) {
    await runConfigDev(opts.configPath, opts.inspect);
    return;
  }
  const backendDir = resolve(opts.backendDir);
  const appDir = resolve(opts.appDir);
  const generatedDir = join(appDir, 'generated');

  const rustBin = () => spawnInherit('cargo', ['run', '--quiet', '--bin', 'generate'], backendDir);
  const tsCli = async () => {
    const cli = process.env.RUSTRA_CLI ?? findRepoCli(appDir);
    if (!cli) {
      console.error('[dev] rustra CLI 를 찾을 수 없음 — RUSTRA_CLI env 지정 필요');
      return;
    }
    await spawnInherit(
      'node',
      [cli, 'generate', '--schema', join(generatedDir, 'schema.json'), '--output', generatedDir],
      appDir,
    );
  };

  const perform = async (reason: string): Promise<void> => {
    console.log(`[dev] ${reason} → codegen`);
    const plan = planPipeline(detectDirty(backendDir, generatedDir));
    if (!plan.rustBin && !plan.tsCli) {
      console.log('[dev] clean — nothing to do');
      return;
    }
    try {
      await runOnce(plan, { rustBin, tsCli });
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (opts.inspect) {
        // CLI 와 앱 JS 프로세스는 분리되어 있어 in-process 계측은 불가 —
        // 앱 측에서 @rustra/devtools 로 엔진을 감싸도록 안내한다 (정직한 범위).
        console.log('[dev:inspect] 앱 프로세스에서 createInstrumentedEngine 로 감싸면');
        console.log('[dev:inspect] report() 를 콘솔/원격으로 노출할 수 있습니다: @rustra/devtools');
      }
    } catch (e) {
      console.error(`[dev] regeneration failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const loop = createWatchLoop(perform, () => {
    const plan = planPipeline(detectDirty(backendDir, generatedDir));
    return plan.rustBin || plan.tsCli;
  });
  await loop.run('initial', true);
  console.log(`\n[dev] watching ${backendDir} for changes...`);
  for (const directory of sourceDirectories(join(backendDir, 'src'))) {
    watch(directory, () => loop.schedule('rust change'));
  }
}

async function runConfigDev(configPath: string, inspect: boolean): Promise<void> {
  const config = readDevConfig(configPath);
  let lastGeneratedSchema: string | undefined;
  const codegen = async () => {
    // CLI 자체가 실행 중이므로 npm 설치에서도 repo dist 경로를 추측하지
    // 않고 동일 프로세스의 codegen 오케스트레이터를 직접 호출한다.
    const { runCodegen } = await import('./index.js');
    await runCodegen(['--config', resolve(configPath)]);
    lastGeneratedSchema = existsSync(config.schemaPath)
      ? readFileSync(config.schemaPath, 'utf8')
      : undefined;
  };

  const perform = async (reason: string): Promise<void> => {
    console.log(`[dev] ${reason} → codegen --config ${resolve(configPath)}`);
    try {
      await codegen();
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (inspect) {
        console.log('[dev:inspect] 앱 프로세스에서 createInstrumentedEngine 로 감싸면');
        console.log('[dev:inspect] report() 를 콘솔/원격으로 노출할 수 있습니다: @rustra/devtools');
      }
    } catch (error) {
      console.error(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    }
  };

  const manifestDir = dirname(config.manifestPath);
  const loop = createWatchLoop(perform, () =>
    detectConfigDirty(manifestDir, config.schemaPath, config.outputPath),
  );
  await loop.run('initial', true);
  const sourceDir = join(manifestDir, 'src');
  const generatedRoots = [config.outputPath, config.schemaPath];
  for (const directory of sourceDirectories(sourceDir)) {
    watch(directory, (_event, filename) => {
      const changed = filename ? resolve(directory, String(filename)) : directory;
      if (generatedRoots.some((root) => isWithin(root, changed))) return;
      loop.schedule('Rust change');
    });
  }
  for (const file of [config.manifestPath, join(manifestDir, 'Cargo.lock')]) {
    if (existsSync(file)) watch(file, () => loop.schedule('config change'));
  }
  if (existsSync(config.schemaPath)) {
    watch(config.schemaPath, () => {
      // Rust generator는 내용이 같아도 schema.json을 write한다. Linux
      // inotify가 발생시키는 자기 write 이벤트를 다시 codegen하지 않는다.
      const current = readFileSync(config.schemaPath, 'utf8');
      if (lastGeneratedSchema !== undefined && current === lastGeneratedSchema) return;
      loop.schedule('schema change');
    });
  }
  console.log(`\n[dev] watching ${manifestDir} and ${config.schemaPath} for changes...`);
}
