/**
 * `rustra dev` — Rust 소스 감시 + dual-path codegen 자동 루프.
 *
 * 기존 `rustra generate --watch` 는 schema.json 변경만 감시하는데 schema.json 은
 * Rust bin 을 실행해야 갱신된다. `rustra dev` 는 backend/src 변경을 감지해
 * (1) Rust bin → types/commands/contract/schema, (2) TS CLI → rkyv-codecs/registry
 * 를 순서대로 재실행한다 (dual-path — runner/template/codegen.sh 와 동일 계약).
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

export interface DevOptions {
  backendDir: string;
  appDir: string;
}

export function parseDevArgs(args: string[]): DevOptions {
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    backendDir: get('backend') ?? 'backend',
    appDir: get('app') ?? 'app',
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

export interface StageRunners {
  rustBin: () => Promise<void>;
  tsCli: () => Promise<void>;
}

/** plan 이 지정한 스테이지만 순서대로 실행 (rust → ts). */
export async function runOnce(plan: PipelinePlan, runners: StageRunners): Promise<void> {
  if (plan.rustBin) await runners.rustBin();
  if (plan.tsCli) await runners.tsCli();
}

function spawnInherit(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit ${code}`)),
    );
    child.on('error', reject);
  });
}

/** rustra CLI 위치 탐색 — codegen.sh 의 find_repo_cli 정책과 동일 (명시 env > 상위 탐색). */
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

  const tick = async (reason: string): Promise<void> => {
    console.log(`[dev] ${reason} → codegen`);
    const dirty = detectDirty(backendDir, generatedDir);
    const plan = planPipeline(dirty);
    if (!plan.rustBin && !plan.tsCli) {
      console.log('[dev] clean — nothing to do');
      return;
    }
    try {
      await runOnce(plan, { rustBin, tsCli });
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
    } catch (e) {
      console.error(`[dev] regeneration failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  await tick('initial');
  console.log(`\n[dev] watching ${backendDir} for changes...`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(join(backendDir, 'src'), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick('rust change'), 300);
  });
}
