import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type WatchLoop = {
  run(reason: string, force?: boolean): Promise<void>;
  schedule(reason: string): void;
  dispose(): void;
  /**
   * Registers a reload hook fired after a successful pipeline run that touched
   * the Rust side (the host's engine must re-initialize). Errors from hooks are
   * logged and swallowed — a broken host callback must never take down codegen
   * watching.
   *
   * Level distinction: this loop-level hook fires on EVERY performed run (the
   * loop cannot tell engine-relevant changes apart). The `runDev` handle's
   * `DevWatchHandle.onReload` is the filtered variant — legacy layout gates on
   * `plan.rustBin`; config mode emits on every successful regeneration (it
   * cannot distinguish causes — the conservative default).
   */
  onReload(cb: (reason: string) => void | Promise<void>): void;
};

/**
 * Reload-hook fan-out shared by watch loops. Never throws: hook failures are
 * logged loudly and isolated so one broken host callback cannot kill the loop.
 */
export function createReloadHooks() {
  const hooks: Array<(reason: string) => void | Promise<void>> = [];
  return {
    onReload(cb: (reason: string) => void | Promise<void>): void {
      hooks.push(cb);
    },
    async emitReload(reason: string): Promise<void> {
      for (const hook of hooks) {
        try {
          await hook(reason);
        } catch (error) {
          console.error(
            `[dev] reload failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  };
}

export type FileWatchSpec = {
  path: string;
  onChange: (changedPath: string, filename?: string) => void;
};

export type WatchHandle = {
  dispose(): void;
};

export function combineWatchHandles(...handles: readonly WatchHandle[]): WatchHandle {
  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}

/**
 * One queued, disposable state machine for every codegen watch mode.
 *
 * A pipeline never overlaps itself. Events arriving while it is running are
 * coalesced into one follow-up run, and disposal prevents both timers and
 * queued work from touching a closed development session.
 *
 * Reload hooks registered via {@link WatchLoop.onReload} fire after every
 * successful `perform` — the loop cannot tell engine-relevant changes from
 * pure codegen output, so hosts filter by comparing their own state (the
 * conservative default is to treat every regeneration as reload-worthy).
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
  const reload = createReloadHooks();

  const run = async (reason: string, force = false): Promise<void> => {
    if (disposed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      if (force || (await shouldRun())) {
        await perform(reason);
        await reload.emitReload(reason);
      }
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        schedule('queued change');
      }
    }
  };

  function schedule(reason: string): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run(reason);
    }, debounceMs);
  }

  return {
    run,
    schedule,
    onReload: reload.onReload,
    dispose() {
      disposed = true;
      queued = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Watches files/directories and gives callers one disposable subscription. */
export function createFileWatch(specs: readonly FileWatchSpec[]): WatchHandle {
  const watchers = specs.flatMap((spec) => {
    if (!existsSync(spec.path)) return [];
    const isDirectory = statSync(spec.path).isDirectory();
    const watcher = watch(spec.path, (_event, filename) => {
      const name = filename === undefined ? undefined : String(filename);
      const changedPath = isDirectory && name ? resolve(spec.path, name) : spec.path;
      spec.onChange(changedPath, name);
    });
    return [watcher];
  });

  return {
    dispose() {
      for (const watcher of watchers) watcher.close();
    },
  };
}

/** Recursively lists source directories, excluding build/cache trees. */
export function sourceDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'target' || entry.name === 'node_modules') continue;
    directories.push(...sourceDirectories(join(root, entry.name)));
  }
  return directories;
}

export function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export function createSourceWatch(
  root: string,
  onChange: (changedPath: string) => void,
): WatchHandle {
  return createFileWatch(
    sourceDirectories(root).map((path) => ({
      path,
      onChange: (changedPath) => onChange(changedPath),
    })),
  );
}
