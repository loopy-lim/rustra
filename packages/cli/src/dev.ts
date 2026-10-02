import { isBindingOutputPath } from './uniffi-output-boundary.js';
/** `rustra dev` — Rust 소스와 생성물의 dual-phase watch loop. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCliArgs } from './cli-arg-parser.js';
import {
  createFileWatch,
  createSourceWatch,
  createWatchLoop,
  createReloadHooks,
  type WatchHandle,
} from './watch.js';
import { assertDirectory, readDevConfig, readSchemaSnapshot } from './dev-config.js';
import { buildDylibCore, liveArtifactPath, publishGatedArtifact } from './dev-dylib.js';
import { buildWasmEngine } from './dev-wasm.js';
import { captureSchemaParity } from './dev-schema-capture.js';
import {
  devInputFingerprint,
  resolveRustInputPaths,
  type RustInputPaths,
} from './dev-fingerprint.js';
import { runLegacyDev } from './legacy-dev.js';
import { withDevGeneratedInputExclusions } from './dev-generated-inputs.js';
import { createParityGate } from './parity-gate.js';
import { readFile } from 'node:fs/promises';
import { isAbortedOperation } from './process.js';

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
export type DevWatchHandle = {
  /** Cancels commands and watchers immediately; await before removing project inputs. */
  dispose(): Promise<void>;
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
  console.log('[dev:inspect] Wrap your engine with createInstrumentedEngine in the app process');
  console.log('[dev:inspect] to expose report() via console or remote: @rustra/devtools');
}

export async function runDev(args: string[]): Promise<DevWatchHandle> {
  const options = parseDevArgs(args);
  // help 관례 — 조용히 더미 핸들로 돌아온다(출력은 cli-main). 디렉터리 검증·
  // 루프 진입 없음 — 기존 "기본값 객체로 워처 진입" 관례의 대체다. onReload 는
  // reload 루프가 세팅 전이므로 no-op 이 계약상 정확하다(초기 강제 재생성도
  // 관찰되지 않는다).
  if (options.help) return { async dispose() {}, onReload: () => {} };
  // dev 루프의 cargo 스폰(스키마 generate bin, dylib 빌드)은 프로필과 무관하게
  // 증분 컴파일을 켠다 — env 는 프로필을 양방향으로 우선하고(2026-09-21 실측),
  // 증분 여부는 cargo 핑거프린트에 없어 직접 실행하는 cargo 빌드와의 전환 재컴
  // 파일도 없다. 비증분 재컴파일이 웜 루프를 지배하는 것(합성 150 커맨드 크레이트
  // 6.6s → 1.5s)을 루프 스폰에만 끊는다. 사용자가 CARGO_INCREMENTAL 을 이미
  // 세팅했다면(디스크 방어, rust-cache CI 의 0 포함) 그 값을 존중한다.
  if (process.env.CARGO_INCREMENTAL === undefined) {
    process.env.CARGO_INCREMENTAL = '1';
  }
  if (options.configPath) return runConfigDev(options.configPath, options.inspect);
  return runLegacyDev(options);
}

async function runConfigDev(configPath: string, inspect: boolean): Promise<DevWatchHandle> {
  const log = console.log;
  const errorOutput = console.error;
  configPath = resolve(configPath);
  let config = readDevConfig(configPath);
  let manifestDir = dirname(config.manifestPath);
  let configText = '';
  let regenerating = false;
  let lastGeneratedSchema: string | undefined;
  // warm-loop Stage 1(§(b)) — 마지막 **성공** 파이프라인이 소비한 Rust 입력 지문.
  // 프로세스 메모리에만 산다(디스크 상태 없음) — 시작 후 첫 틱은 항상 전체
  // 파이프라인을 돈다. 채택은 성공 틱에서만(아래), 실패·게이트 거부 틱은 이
  // 값을 건드리지 못한다 — 실패 상태의 지문이 다음 틱의 스킵 근거가 되는
  // fail-open 을 막는다.
  let lastSuccessfulFingerprint: string | undefined;
  let inputPaths: RustInputPaths;
  let inputPathKey = '';
  let subscriptions: WatchHandle[] = [];
  let disposed = false;
  const cancellation = new AbortController();
  let gate: ReturnType<typeof createParityGate> | undefined;
  let gateKey = '';
  let gateArmed = false;
  const reload = createReloadHooks();

  function subscribe(): void {
    for (const watch of subscriptions) watch.dispose();
    inputPaths = resolveRustInputPaths(
      config.manifestPath,
      config.rustPackage,
      config.root,
      [config.devDylib, config.devWasm].flatMap((engine) =>
        engine
          ? [
              {
                manifestPath: engine.manifestPath,
                rustPackage: engine.rustPackage,
                cwd: dirname(engine.manifestPath),
              },
            ]
          : [],
      ),
    );
    const cargoExcluded = inputPaths.excluded;
    inputPaths = withDevGeneratedInputExclusions(inputPaths, config);
    // Ownership changes only filter generated bytes. Cargo discoveries still
    // need a fresh pre-build baseline, even when their files currently match.
    inputPathKey = JSON.stringify({ ...inputPaths, excluded: cargoExcluded });
    subscriptions = [
      ...inputPaths.trees.map((tree) =>
        createSourceWatch(
          tree,
          (changed) => {
            if (config.uniffiBindingPath && isBindingOutputPath(config.uniffiBindingPath, changed))
              return;
            loop.schedule('Rust change');
          },
          inputPaths.excluded,
        ),
      ),
      createFileWatch(
        inputPaths.files.map((path) => ({
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
    log(`[dev] ${reason} → codegen --config ${configPath}`);
    regenerating = true;
    try {
      const nextText = await readFile(configPath, 'utf8');
      if (disposed) return;
      if (nextText !== configText) {
        const next = readDevConfig(configPath);
        assertDirectory(
          dirname(next.manifestPath),
          'Cargo project root',
          'set codegen.rustManifest',
        );
        config = next;
        manifestDir = dirname(config.manifestPath);
        configText = nextText;
        lastGeneratedSchema = undefined;
        // 설정이 바뀌면 지문의 대상(매니페스트·스키마 경로)도 바뀐다 — 이전
        // 설정 시대의 지문은 비교 근거가 아니므로 버리고, 이 틱부터 전체
        // 파이프라인으로 재기준을 잡는다.
        lastSuccessfulFingerprint = undefined;
        if (!disposed) subscribe();
      } else if (!disposed) {
        // Re-resolve local dependency/target roots after Cargo input edits.
        // Cache hits read only manifest bytes; no extra Cargo process on a no-op tick.
        subscribe();
      }
      // 이 틱에서 codegen 이전에 arm 했는지 — 수행 지역 변수라서 pipeline 이
      // 중간에 실패하면 다음 틱으로 이어지지 않는다(끼인 기준의 무음 채택 금지).
      let armedPreCodegen = false;
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
          armedPreCodegen = true;
        }
      }
      if (disposed) return;
      // Watch roots and compiler-discovered inputs must match the last successful
      // build by content. The published schema must also match our own snapshot;
      // an external edit or uncertain read always runs the full pipeline.
      let decisionFingerprint: string | undefined;
      const decisionPaths = inputPathKey;
      try {
        decisionFingerprint = devInputFingerprint(inputPaths);
      } catch {
        // throw = 불확실 — 스킵 근거로 쓰지 않는다(dev-fingerprint.ts 계약).
        decisionFingerprint = undefined;
      }
      const skippedCargoStage =
        decisionFingerprint !== undefined &&
        decisionFingerprint === lastSuccessfulFingerprint &&
        lastGeneratedSchema !== undefined &&
        readSchemaSnapshot(config.schemaPath) === lastGeneratedSchema;
      let dylibPublish: { artifact: string; livePath: string } | undefined;
      if (skippedCargoStage) {
        log('[dev] rust inputs unchanged — skipping cargo stage (fingerprint match)');
      } else {
        const { runCodegen } = await import('./cli-codegen.js');
        await runCodegen(['--config', configPath], { signal: cancellation.signal });
        if (disposed) return;
        lastGeneratedSchema = readSchemaSnapshot(config.schemaPath);
        if (config.devWasm) {
          const artifact = await buildWasmEngine(config.devWasm, cancellation.signal);
          if (disposed) return;
          log(`[dev:wasm] engine artifact: ${artifact}`);
        }
        if (config.devDylib) {
          const artifact = await buildDylibCore(config.devDylib, cancellation.signal);
          if (disposed) return;
          log(`[dev:dylib] core artifact: ${artifact}`);
          dylibPublish = { artifact, livePath: liveArtifactPath(artifact) };
        }
      }
      if (disposed) return;
      if (gate) {
        if (!gateArmed || armedPreCodegen) {
          // codegen 이전 기준(시작 시 stale schema.json 포함 — 리스크 감사
          // 2026-09-13 #7)은 방금 재생성된 계약과 무관하므로 재생성 직후 기준을
          // 다시 잡는다. 실패로 끼인 틱의 기준은 여기에 못 미친다(지역 변수) —
          // 다음 틱은 마지막 기준 대비 실제 드리프트 검증을 거친다(fail-closed
          // 불변). 이 재-arm 이 드리프트 허용이 아니다.
          await gate.arm();
          gateArmed = true;
        } else {
          const verdict = await gate.verify();
          if (disposed) return;
          if (!verdict.ok) {
            errorOutput(`[dev] reload rejected — ${verdict.reason}`);
            if (dylibPublish) {
              errorOutput(
                existsSync(dylibPublish.livePath)
                  ? `[dev:dylib] gated live artifact untouched at ${dylibPublish.livePath} — the host keeps running the previously published core`
                  : '[dev:dylib] no gated live artifact was published — do not launch the host',
              );
            }
            return;
          }
        }
      }
      if (disposed) return;
      if (dylibPublish) {
        const livePath = publishGatedArtifact(dylibPublish.artifact, dylibPublish.livePath);
        log(`[dev:dylib] launch the host with RUSTRA_HOT_CORE=${livePath}`);
      }
      // 지문 채택 — 성공 틱 한정(게이트 거부는 위에서 return, 빌드 실패는 catch 로
      // 가므로 여기에 못 미친다). 코드젠이 **소비한** 입력의 판정 시점 지문을
      // 채택한다: 코드젠 도중의 편집은 다음 틱 지문을 바꿔놓았을 것이므로, 채택값이
      // 코드젠 뒤 디스크 재계산값이라면 그 편집이 스킵에 삼켜지는 구멍이 생긴다.
      // 계산 실패(undefined) 틱은 채택을 보류 — 다음 틱도 전체 파이프라인을 돈다.
      // A first build can discover include!/build-script inputs through Cargo
      // dep-info. Start watching them now, then run once with a pre-build
      // fingerprint of the expanded set rather than adopting a post-build read.
      subscribe();
      const discoveredInputs = inputPathKey !== decisionPaths;
      let editedDuringBuild = false;
      if (!discoveredInputs && decisionFingerprint !== undefined) {
        try {
          editedDuringBuild = devInputFingerprint(inputPaths) !== decisionFingerprint;
        } catch {
          editedDuringBuild = true;
        }
      }
      lastSuccessfulFingerprint = discoveredInputs ? undefined : decisionFingerprint;
      if (discoveredInputs) loop.schedule('Cargo inputs discovered');
      // Replacing subscriptions must not swallow edits between the last poll
      // and publication. A new watcher starts at the current disk snapshot.
      if (editedDuringBuild) loop.schedule('Rust inputs changed during build');
      log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (inspect) inspectHint();
      await reload.emitReload(reason);
    } catch (error) {
      if (isAbortedOperation(error, cancellation.signal)) return;
      errorOutput(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
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
  log(`\n[dev] watching ${manifestDir} and ${configPath} for changes...`);
  return {
    dispose() {
      disposed = true;
      cancellation.abort();
      const drained = loop.dispose();
      configWatch.dispose();
      for (const watch of subscriptions) watch.dispose();
      return drained;
    },
    onReload: reload.onReload,
  };
}
