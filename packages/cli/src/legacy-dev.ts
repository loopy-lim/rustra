import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertDirectory, findRepoCli, readSchemaSnapshot } from './dev-config.js';
import {
  devInputFingerprint,
  resolveRustInputPaths,
  type RustInputPaths,
} from './dev-fingerprint.js';
import { detectDirty, planPipeline, runOnce, type PipelinePlan } from './dev-support.js';
import { withDevGeneratedInputExclusions } from './dev-generated-inputs.js';
import { isAbortedOperation, spawnInherit } from './process.js';
import {
  createFileWatch,
  createSourceWatch,
  createWatchLoop,
  createReloadHooks,
  isWithin,
  type WatchHandle,
} from './watch.js';
import type { DevOptions, DevWatchHandle } from './dev.js';

/** Legacy --backend/--app orchestration with the same Rust input boundary as config mode. */
export async function runLegacyDev(options: DevOptions): Promise<DevWatchHandle> {
  const log = console.log;
  const errorOutput = console.error;
  const backend = resolve(options.backendDir);
  const app = resolve(options.appDir);
  const generated = join(app, 'generated');
  const schema = join(generated, 'schema.json');
  const manifest = join(backend, 'Cargo.toml');
  assertDirectory(backend, 'backend', 'rustra dev --backend <dir>');
  assertDirectory(join(backend, 'src'), 'backend/src', 'rustra dev --backend <dir>');
  assertDirectory(app, 'app', 'rustra dev --app <dir>');
  if (!process.env.RUSTRA_CLI && !findRepoCli(app))
    throw new Error(
      `Could not find the Rustra CLI from ${app}. Install @rustra/cli or set RUSTRA_CLI.`,
    );

  const fallbackPaths = (): RustInputPaths => ({
    trees: [join(backend, 'src')],
    files: [manifest, join(backend, 'Cargo.lock'), join(backend, 'build.rs')],
  });
  let paths = withDevGeneratedInputExclusions(fallbackPaths(), {
    outputPath: generated,
    schemaPath: schema,
  });
  let inputPathKey = '';
  let watches: WatchHandle[] = [];
  let disposed = false;
  const cancellation = new AbortController();
  let initialized = false;
  let successfulFingerprint: string | undefined;
  let generatedSchema: string | undefined;
  const reload = createReloadHooks();
  const fingerprint = (): string | undefined => {
    try {
      return devInputFingerprint(paths);
    } catch {
      return undefined;
    }
  };
  const refreshPaths = (): RustInputPaths => {
    const resolved = existsSync(manifest)
      ? resolveRustInputPaths(manifest, undefined, backend)
      : fallbackPaths();
    const next = withDevGeneratedInputExclusions(resolved, {
      outputPath: generated,
      schemaPath: schema,
    });
    inputPathKey = JSON.stringify({ ...next, excluded: resolved.excluded });
    return next;
  };
  const plan = (): PipelinePlan => {
    if (!initialized) {
      // Cargo-backed inputs need one known successful baseline. Preserve the legacy
      // clean/no-Cargo layout used for manually seeded generation fixtures.
      return existsSync(manifest)
        ? { rustBin: true, tsCli: true }
        : planPipeline(detectDirty(backend, generated));
    }
    const current = fingerprint();
    const rustBin = current === undefined || current !== successfulFingerprint;
    return {
      rustBin,
      tsCli:
        rustBin ||
        readSchemaSnapshot(schema) !== generatedSchema ||
        detectDirty(backend, generated).codecsStaleAgainstSchema,
    };
  };
  const subscribe = (next: RustInputPaths) => {
    paths = next;
    for (const watch of watches) watch.dispose();
    const excluded = paths.excluded ?? [];
    const watchedFiles: { path: string; onChange: () => void }[] = [];
    for (const path of paths.files) {
      if (!excluded.some((root) => isWithin(root, path)))
        watchedFiles.push({ path, onChange: () => loop.schedule('Cargo change') });
    }
    watches = [
      ...paths.trees.map((tree) =>
        createSourceWatch(tree, () => loop.schedule('Rust change'), excluded),
      ),
      createFileWatch(watchedFiles),
      createFileWatch(
        [schema, join(generated, 'frame-codecs.ts'), join(generated, 'frame-registry.ts')].map(
          (path) => ({ path, onChange: () => loop.schedule('schema change') }),
        ),
      ),
    ];
  };
  const rustBin = () =>
    spawnInherit('cargo', ['run', '--quiet', '--bin', 'generate'], backend, {
      signal: cancellation.signal,
    });
  const tsCli = async () => {
    const cli = process.env.RUSTRA_CLI ?? findRepoCli(app);
    if (!cli) throw new Error('Rustra CLI is unavailable; set RUSTRA_CLI.');
    await spawnInherit('node', [cli, 'generate', '--schema', schema, '--output', generated], app, {
      signal: cancellation.signal,
    });
  };
  const perform = async (reason: string) => {
    log(`[dev] ${reason} → codegen`);
    try {
      if (!disposed) subscribe(refreshPaths());
      const next = plan();
      if (!next.rustBin && !next.tsCli) {
        successfulFingerprint = fingerprint();
        generatedSchema = readSchemaSnapshot(schema);
        initialized = true;
        log('[dev] clean — nothing to do');
        return;
      }
      const before = fingerprint();
      const beforePaths = inputPathKey;
      await runOnce(next, { rustBin, tsCli });
      if (disposed) return;
      subscribe(refreshPaths());
      const after = fingerprint();
      initialized = true;
      generatedSchema = readSchemaSnapshot(schema);
      const stable = before !== undefined && before === after && beforePaths === inputPathKey;
      successfulFingerprint = stable ? before : undefined;
      if (!stable) loop.schedule('Rust inputs changed during regeneration');
      log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
      if (options.inspect) {
        log('[dev:inspect] Wrap your engine with createInstrumentedEngine in the app process');
        log('[dev:inspect] to expose report() via console or remote: @rustra/devtools');
      }
      if (next.rustBin) await reload.emitReload(reason);
    } catch (error) {
      if (isAbortedOperation(error, cancellation.signal)) return;
      errorOutput(`[dev] regeneration failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const loop = createWatchLoop(perform, () => {
    const next = plan();
    return next.rustBin || next.tsCli;
  });
  subscribe(paths);
  await loop.run('initial', true);
  log(`\n[dev] watching ${backend} for changes...`);
  return {
    dispose() {
      disposed = true;
      cancellation.abort();
      const drained = loop.dispose();
      for (const watch of watches) watch.dispose();
      return drained;
    },
    onReload: reload.onReload,
  };
}
