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
import type { ResolvedDevWasm } from './dev-config.js';
import { detectConfigDirty, detectDirty, planPipeline, runOnce } from './dev-support.js';
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
  // Task A2 — dev.target=wasm 이면 parity 게이트를 기본 켠다(`wasm.parityGate:
  // false` 로 명시 끄기 전까지). capture 는 빌드타임 계약을 읽는다(계약 해시의
  // 단일 소싱 근거는 captureSchemaParity 문서 참조). 코드젠이 만든 schema.json 은
  // reload 방출 **전부터** 최종 상태이므로, 방출 직전에 미리 검증해도 방출 후
  // 검증과 같은 판정이다 — 오히려 거부 시 reload 가 아예 방출되지 않아 호스트가
  // 기존 엔진을 유지하는 것이 보장된다(방출 후 검증은 이미 호스트가 새 계약을
  // 로드한 뒤라 롤백 책임이 호스트로 넘어간다). 불일치·capture 실패는 loud
  // 기록되고 emitReload 는 건너뛴다. 루프 자체는 살아남는다(다음 변경에 다시
  // 판정). 네이티브 타깃은 게이트 없다.
  const wasmDev = config.dev?.target === 'wasm';
  const gate =
    // readDevConfig 가 wasm.parityGate 기본값(true)을 채워 주므로(주석은
    // dev-config.ts) 곧장 진리 판정한다 — `!== false` 재판정 불필요.
    wasmDev && config.dev?.wasm?.parityGate
      ? createParityGate({ capture: () => captureSchemaParity(config.schemaPath) })
      : undefined;
  const codegen = async () => {
    const { runCodegen } = await import('./index.js');
    await runCodegen(['--config', resolve(configPath)]);
    lastGeneratedSchema = readSchemaSnapshot(config.schemaPath);
  };
  const perform = async (reason: string) => {
    console.log(`[dev] ${reason} → codegen --config ${resolve(configPath)}`);
    try {
      await codegen();
      // Task A3 — target=wasm 이면 코드젠에 이어 wasm32 엔진 빌드를
      // 오케스트레이션한다(A0 스파이크의 빌드 명령·산출물 레이아웃과 동일). 빌드
      // 실패는 throw 로 전파되어 아래 catch 로 간다 — 새 엔진이 존재하지 않는
      // reload 를 방출하지 않기 위해 게이트 검증보다 **먼저** 실패해야 한다.
      // 기기로의 푸시(adb push / Documents 등)는 호스트 영역 — 산출물 경로 안내가
      // 오케스트레이션의 끝이다.
      if (config.devWasm) {
        const artifact = await buildWasmEngine(config.devWasm);
        console.log(`[dev:wasm] engine artifact: ${artifact}`);
      }
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (inspect) inspectHint();
      if (gate) {
        const verdict = await gate.verify();
        if (!verdict.ok) {
          // 거부 — reload 신호를 방출하지 않는다(호스트는 기존 엔진 유지).
          // verdict 가 이미 현재 상태로 재무장했으므로 다음 변경은 정상 판정된다.
          console.error(`[dev] reload rejected — ${verdict.reason}`);
          return;
        }
      }
      await reload.emitReload(reason);
    } catch (error) {
      console.error(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const loop = createWatchLoop(perform, () =>
    detectConfigDirty(manifestDir, config.schemaPath, config.outputPath),
  );
  await loop.run('initial', true);
  // 기준 스냅샷은 initial 코드젠이 schema.json 을 만든 **뒤**에 잡는다 — 없는
  // 파일 앞에서 arm 이 실패하는 일을 막는다. arm 실패는 throw — 게이트가
  // 요구됨(wasm + parityGate 기본)에도 계약을 못 잡는 상태로 감시에 들어가는
  // 것은 fail-open 이므로 즉시 보인다.
  if (gate) await gate.arm();
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
