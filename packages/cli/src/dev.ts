import { isBindingOutputPath } from './uniffi-output-boundary.js';
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
  createReloadHooks,
  type WatchHandle,
} from './watch.js';
import { assertDirectory, findRepoCli, readDevConfig, readSchemaSnapshot } from './dev-config.js';
import type { ResolvedDevWasm } from './dev-config.js';
import { buildDylibCore, liveArtifactPath, publishGatedArtifact } from './dev-dylib.js';
import { detectDirty, planPipeline, runOnce } from './dev-support.js';
import { createParityGate, type ParitySnapshot } from './parity-gate.js';
import { readCargoMetadata, selectHostPackage, requireTargetDirectory } from './cargo-metadata.js';
import { sha256 } from './hash.js';
import { readFile } from 'node:fs/promises';

/** cargo 규약 — cdylib wasm32 릴리스 산출물 이름(lib 타깃 이름의 `-` → `_`). */
function wasmArtifactName(libName: string): string {
  return `${libName.replaceAll('-', '_')}.wasm`;
}

/**
 * wasm32 엔진 아티팩트 경로 — A0 스파이크(`scripts/build-backend.sh`)가 실제로
 * 생산하는 레이아웃을 그대로 따른다:
 * `<target_directory>/wasm32-unknown-unknown/release/<crate_name>.wasm`
 * 이름 근원은 패키지가 아니라 **lib 타깃** 이름이다 — cargo 는 cdylib 산출물
 * 이름을 `[lib] name`(지정 없으면 패키지 이름)에서 가져온다. 이 저장소의 RN
 * 관례(`lib${rustLibrary}.a`)와 같은 근원이다.
 */
export function wasmEngineArtifactPath(
  manifestPath: string,
  libName: string,
  metadata = readCargoMetadata(manifestPath),
): string {
  return join(
    requireTargetDirectory(metadata),
    'wasm32-unknown-unknown',
    'release',
    wasmArtifactName(libName),
  );
}

/**
 * wasm dev 타깃(Task A3)의 rust 재빌드 단계 — 엔진 crate 의 cdylib 를
 * wasm32-unknown-unknown 으로 빌드하고 산출물 경로를 돌려준다. 매니페스트의
 * 패키지 중 cdylib 타깃을 가진 것을 고른다(reactNative.rustPackage 지정 시 그
 * 패키지로 한정). 릴리스 프로필(`--release`)은 A0 스파이크가 검증한 구성
 * (opt-level "s", panic=abort)과 동일하다 — dev 편의 프로필을 새로 발명하지 않는다.
 */
export async function buildWasmEngine(devWasm: ResolvedDevWasm): Promise<string> {
  const manifestPath = devWasm.manifestPath;
  const metadata = readCargoMetadata(manifestPath);
  const cargoPackage = selectHostPackage(metadata, manifestPath, devWasm.rustPackage);
  const cdylibs = cargoPackage.targets.filter((target) => target.crate_types.includes('cdylib'));
  if (cdylibs.length !== 1) {
    throw new Error(
      `wasm engine build requires exactly one cdylib target in package ${cargoPackage.name}, found ${cdylibs.length}. ` +
        `Add crate-type = ["rlib", "cdylib"] to ${manifestPath}` +
        (devWasm.rustPackage ? '' : `, or set reactNative.rustPackage in rustra.json`),
    );
  }
  const artifactPath = wasmEngineArtifactPath(manifestPath, cdylibs[0]!.name, metadata);
  await spawnInherit(
    'cargo',
    ['build', '--manifest-path', manifestPath, '--target', 'wasm32-unknown-unknown', '--release'],
    dirname(manifestPath),
    {
      progressLabel: `wasm32 engine build (${cargoPackage.name})`,
      childOutput: 'inherit',
    },
  );
  if (!existsSync(artifactPath)) {
    throw new Error(
      `wasm32 build did not produce ${artifactPath} — the cdylib target must compile for wasm32-unknown-unknown`,
    );
  }
  return artifactPath;
}

/**
 * 빌드타임 parity 캡처 — schema.json 의 SHA-256. cd243cec 단일 소싱 계약상 이
 * 해시는 `rustra_ffi_contract_hash` 및 생성물 `GENERATED_CONTRACT_HASH` 와 같은
 * 원본(schema 직렬화)을 해시하므로, dev 루프는 라이브 엔진 없이도 "reload 전후
 * 계약이 갈라졌는가"를 판정할 수 있다. golden wire 상태는 호스트 훅(A1
 * onReload)이 주입하는 영역이라 여기서는 undefined 다.
 */
async function captureSchemaParity(schemaPath: string): Promise<ParitySnapshot> {
  const schema = await readFile(schemaPath, 'utf8');
  return { contractHash: sha256(schema) };
}

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
  /** help 관례 — 파서가 플래그를 채우고 출력은 cli-main 이 담당한다. */
  help?: boolean;
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
    booleanFlags: ['inspect', 'help'],
  });
  return {
    ...(parsed.flags.has('help') ? { help: true } : {}),
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
  // help 관례 — 조용히 더미 핸들로 돌아온다(출력은 cli-main). 디렉터리 검증·
  // 루프 진입 없음 — 기존 "기본값 객체로 워처 진입" 관례의 대체다. onReload 는
  // reload 루프가 세팅 전이므로 no-op 이 계약상 정확하다(초기 강제 재생성도
  // 관찰되지 않는다).
  if (options.help) return { dispose() {}, onReload: () => {} };
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
  configPath = resolve(configPath);
  let config = readDevConfig(configPath);
  let manifestDir = dirname(config.manifestPath);
  let configText = '';
  let regenerating = false;
  let lastGeneratedSchema: string | undefined;
  let subscriptions: WatchHandle[] = [];
  let disposed = false;
  let gate: ReturnType<typeof createParityGate> | undefined;
  let gateKey = '';
  let gateArmed = false;
  const reload = createReloadHooks();

  function subscribe(): void {
    for (const watch of subscriptions) watch.dispose();
    const generatedRoots = [
      config.outputPath,
      config.schemaPath,
      ...(config.uniffiMirrorPath ? [config.uniffiMirrorPath] : []),
    ];
    subscriptions = [
      createSourceWatch(join(manifestDir, 'src'), (changed) => {
        if (config.uniffiBindingPath && isBindingOutputPath(config.uniffiBindingPath, changed))
          return;
        if (!generatedRoots.some((root) => isWithin(root, changed))) loop.schedule('Rust change');
      }),
      createFileWatch(
        [config.manifestPath, join(manifestDir, 'Cargo.lock')].map((path) => ({
          path,
          onChange: () => loop.schedule('Cargo change'),
        })),
      ),
      createFileWatch([
        {
          path: config.schemaPath,
          onChange: () => {
            if (regenerating) return;
            if (
              existsSync(config.schemaPath) &&
              readSchemaSnapshot(config.schemaPath) === lastGeneratedSchema
            )
              return;
            loop.schedule('schema change');
          },
        },
      ]),
    ];
  }

  const perform = async (reason: string) => {
    console.log(`[dev] ${reason} → codegen --config ${configPath}`);
    regenerating = true;
    try {
      const nextText = await readFile(configPath, 'utf8');
      if (nextText !== configText) {
        const next = readDevConfig(configPath);
        assertDirectory(
          dirname(next.manifestPath),
          'Cargo project root',
          'set codegen.rustManifest',
        );
        assertDirectory(
          join(dirname(next.manifestPath), 'src'),
          'Rust src',
          'set codegen.rustManifest',
        );
        config = next;
        manifestDir = dirname(config.manifestPath);
        configText = nextText;
        lastGeneratedSchema = undefined;
        if (!disposed) subscribe();
      }
      const gateEnabled =
        (config.dev?.target === 'wasm' && config.dev?.wasm?.parityGate) ||
        (config.dev?.target === 'dylib' && config.dev?.dylib?.parityGate);
      const nextGateKey = gateEnabled ? `${config.dev?.target}:${config.schemaPath}` : '';
      if (gateKey !== nextGateKey) {
        gateKey = nextGateKey;
        gate = gateEnabled
          ? createParityGate({ capture: () => captureSchemaParity(config.schemaPath) })
          : undefined;
        gateArmed = false;
        if (gate && existsSync(config.schemaPath)) {
          await gate.arm();
          gateArmed = true;
        }
      }
      const { runCodegen } = await import('./cli-codegen.js');
      await runCodegen(['--config', configPath]);
      lastGeneratedSchema = readSchemaSnapshot(config.schemaPath);
      if (config.devWasm) {
        const artifact = await buildWasmEngine(config.devWasm);
        console.log(`[dev:wasm] engine artifact: ${artifact}`);
      }
      let dylibPublish: { artifact: string; livePath: string } | undefined;
      if (config.devDylib) {
        const artifact = await buildDylibCore(config.devDylib);
        console.log(`[dev:dylib] core artifact: ${artifact}`);
        dylibPublish = { artifact, livePath: liveArtifactPath(artifact) };
      }
      if (disposed) return;
      if (gate) {
        if (!gateArmed) {
          await gate.arm();
          gateArmed = true;
        } else {
          const verdict = await gate.verify();
          if (!verdict.ok) {
            console.error(`[dev] reload rejected — ${verdict.reason}`);
            if (dylibPublish) {
              console.error(
                existsSync(dylibPublish.livePath)
                  ? `[dev:dylib] gated live artifact untouched at ${dylibPublish.livePath} — the host keeps running the previously published core`
                  : '[dev:dylib] no gated live artifact was published — do not launch the host',
              );
            }
            return;
          }
        }
      }
      if (dylibPublish) {
        const livePath = publishGatedArtifact(dylibPublish.artifact, dylibPublish.livePath);
        console.log(`[dev:dylib] launch the host with RUSTRA_HOT_CORE=${livePath}`);
      }
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (inspect) inspectHint();
      await reload.emitReload(reason);
    } catch (error) {
      console.error(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      regenerating = false;
    }
  };
  // Events themselves establish dirtiness (including deletion/config changes),
  // which timestamp comparisons against generated files cannot reliably infer.
  const loop = createWatchLoop(perform, () => true);
  const configWatch = createFileWatch([
    { path: configPath, onChange: () => loop.schedule('config change') },
  ]);
  await loop.run('initial', true);
  console.log(`\n[dev] watching ${manifestDir} and ${configPath} for changes...`);
  return {
    dispose() {
      disposed = true;
      loop.dispose();
      configWatch.dispose();
      for (const watch of subscriptions) watch.dispose();
    },
    onReload: reload.onReload,
  };
}
