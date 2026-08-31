/** `rustra dev` — Rust 소스와 생성물의 dual-phase watch loop. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnInherit } from './process.js';
import { parseCliArgs } from './cli-arg-parser.js';
import {
  createFileWatch,
  createSourceWatch,
  createWatchLoop,
  isWithin,
  sourceDirectories,
  createReloadHooks,
  type WatchHandle,
} from './watch.js';
import { assertDirectory, findRepoCli, readDevConfig, readSchemaSnapshot } from './dev-config.js';
import { detectConfigDirty, detectDirty, planPipeline, runOnce } from './dev-support.js';

export { createWatchLoop, createReloadHooks } from './watch.js';
export type { WatchLoop } from './watch.js';
export {
  detectConfigDirty,
  detectDirty,
  planPipeline,
  runOnce,
  type PipelinePlan,
  type StageRunners,
} from './dev-support.js';
export { readDevConfig } from './dev-config.js';

export interface DevOptions {
  configPath?: string;
  backendDir: string;
  appDir: string;
  inspect: boolean;
}

/**
 * Watch handle returned by `runDev`/`runConfigDev` with the engine-reload hook.
 * The callback contract: invoked AFTER codegen completes for a run that touched
 * the Rust side (rustBin) and BEFORE the loop idles again; the host drains its
 * own in-flight invocations, then re-initializes its engine. Errors from the
 * callback are logged (`[dev] reload failed: …`) and never kill the loop.
 *
 * Registration timing: `onReload` exists only after `runDev`/`runConfigDev`
 * returns — the initial forced regeneration is therefore never observed as a
 * reload; hooks see subsequent watch-loop runs only.
 */
export type DevWatchHandle = WatchHandle & {
  onReload(cb: (reason: string) => void | Promise<void>): void;
};

export function parseDevArgs(args: string[]): DevOptions {
  const parsed = parseCliArgs(args, {
    command: 'dev',
    valueFlags: ['config', 'backend', 'app'],
    booleanFlags: ['inspect', 'help', 'h'],
  });
  if (parsed.flags.has('help') || parsed.flags.has('h')) {
    return { backendDir: 'backend', appDir: 'app', inspect: false };
  }
  return {
    configPath: parsed.values.get('config'),
    backendDir: parsed.values.get('backend') ?? 'backend',
    appDir: parsed.values.get('app') ?? 'app',
    inspect: parsed.flags.has('inspect'),
  };
}

function inspectHint(): void {
  console.log('[dev:inspect] 앱 프로세스에서 createInstrumentedEngine 로 감싸면');
  console.log('[dev:inspect] report() 를 콘솔/원격으로 노출할 수 있습니다: @rustra/devtools');
}

function watchPlan(backendDir: string, generatedDir: string): () => boolean {
  return () => {
    const plan = planPipeline(detectDirty(backendDir, generatedDir));
    return plan.rustBin || plan.tsCli;
  };
}

export async function runDev(args: string[]): Promise<DevWatchHandle> {
  const options = parseDevArgs(args);
  if (options.configPath) return runConfigDev(options.configPath, options.inspect);
  const backendDir = resolve(options.backendDir);
  const appDir = resolve(options.appDir);
  const generatedDir = join(appDir, 'generated');
  assertDirectory(backendDir, 'backend', 'rustra dev --backend <dir>');
  assertDirectory(join(backendDir, 'src'), 'backend/src', 'rustra dev --backend <dir>');
  assertDirectory(appDir, 'app', 'rustra dev --app <dir>');
  if (!process.env.RUSTRA_CLI && !findRepoCli(appDir)) {
    throw new Error(
      `Could not find the Rustra CLI from ${appDir}. Install @rustra/cli or set RUSTRA_CLI.`,
    );
  }
  const rustBin = () => spawnInherit('cargo', ['run', '--quiet', '--bin', 'generate'], backendDir);
  const reload = createReloadHooks();
  const tsCli = async () => {
    const cli = process.env.RUSTRA_CLI ?? findRepoCli(appDir);
    if (!cli) throw new Error('Rustra CLI is unavailable; set RUSTRA_CLI.');
    await spawnInherit(
      'node',
      [cli, 'generate', '--schema', join(generatedDir, 'schema.json'), '--output', generatedDir],
      appDir,
    );
  };
  const perform = async (reason: string) => {
    console.log(`[dev] ${reason} → codegen`);
    const plan = planPipeline(detectDirty(backendDir, generatedDir));
    if (!plan.rustBin && !plan.tsCli) return console.log('[dev] clean — nothing to do');
    try {
      await runOnce(plan, { rustBin, tsCli });
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (options.inspect) inspectHint();
      // Rust 소스가 바뀌었다(rustBin 단계가 돌았다) → reload 신호. 네이티브
      // 바이너리 반영 여부는 호스트 재빌드/스폰 시점에 달렸다 — 신호의 책임은
      // "Rust 측 변경" 통보까지다.
      if (plan.rustBin) await reload.emitReload(reason);
    } catch (error) {
      console.error(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const loop = createWatchLoop(perform, watchPlan(backendDir, generatedDir));
  await loop.run('initial', true);
  console.log(`\n[dev] watching ${backendDir} for changes...`);
  const sourceWatch = createSourceWatch(join(backendDir, 'src'), () =>
    loop.schedule('rust change'),
  );
  const handle: DevWatchHandle = {
    dispose() {
      loop.dispose();
      sourceWatch.dispose();
    },
    onReload: reload.onReload,
  };
  return handle;
}

async function runConfigDev(configPath: string, inspect: boolean): Promise<DevWatchHandle> {
  const config = readDevConfig(configPath);
  const manifestDir = dirname(config.manifestPath);
  assertDirectory(manifestDir, 'Cargo project root', 'set codegen.rustManifest');
  assertDirectory(join(manifestDir, 'src'), 'Rust src', 'set codegen.rustManifest');
  let lastGeneratedSchema: string | undefined;
  // detectConfigDirty 는 rust/ts 원인을 구분하지 못한다 — 보수적 기본값으로
  // 성공한 재생성마다 reload 를 방출한다(호스트 재초기화는 멱함수여야 한다).
  const reload = createReloadHooks();
  const codegen = async () => {
    const { runCodegen } = await import('./index.js');
    await runCodegen(['--config', resolve(configPath)]);
    lastGeneratedSchema = readSchemaSnapshot(config.schemaPath);
  };
  const perform = async (reason: string) => {
    console.log(`[dev] ${reason} → codegen --config ${resolve(configPath)}`);
    try {
      await codegen();
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (inspect) inspectHint();
      await reload.emitReload(reason);
    } catch (error) {
      console.error(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const loop = createWatchLoop(perform, () =>
    detectConfigDirty(manifestDir, config.schemaPath, config.outputPath),
  );
  await loop.run('initial', true);
  const generatedRoots = [config.outputPath, config.schemaPath];
  const sourceWatch = createFileWatch(
    sourceDirectories(join(manifestDir, 'src')).map((path) => ({
      path,
      onChange: (changed) => {
        if (!generatedRoots.some((root) => isWithin(root, changed))) loop.schedule('Rust change');
      },
    })),
  );
  const projectWatch = createFileWatch(
    [config.manifestPath, join(manifestDir, 'Cargo.lock')].map((path) => ({
      path,
      onChange: () => loop.schedule('config change'),
    })),
  );
  const schemaWatch = createFileWatch([
    {
      path: dirname(config.schemaPath),
      onChange: (changed) => {
        if (resolve(changed) !== resolve(config.schemaPath) || !existsSync(config.schemaPath))
          return;
        if (
          lastGeneratedSchema !== undefined &&
          readSchemaSnapshot(config.schemaPath) === lastGeneratedSchema
        )
          return;
        loop.schedule('schema change');
      },
    },
  ]);
  console.log(`\n[dev] watching ${manifestDir} and ${config.schemaPath} for changes...`);
  const handle: DevWatchHandle = {
    dispose() {
      loop.dispose();
      sourceWatch.dispose();
      projectWatch.dispose();
      schemaWatch.dispose();
    },
    onReload: reload.onReload,
  };
  return handle;
}
