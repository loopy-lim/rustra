import { existsSync, readdirSync, lstatSync } from 'node:fs';
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
      // 훅은 서로 독립(호스트별 콜백)이므로 병렬로 방출한다. allSettled 로
      // 격리 계약을 유지 — 한 훅의 실패가 다른 훅을 막지 않고 소리 내어 기록된다.
      // Promise.resolve().then 으로 감싸는 이유: 동기 throw 도 rejection 으로
      // 정규화해 allSettled 가 받도록 한다(map 이 중간에 던지는 것을 막는다).
      const results = await Promise.allSettled(
        hooks.map((hook) => Promise.resolve().then(() => hook(reason))),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(
            `[dev] reload failed: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`,
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
      void run(reason).catch((error: unknown) => {
        console.error(
          `[dev] scheduled run failed: ${error instanceof Error ? error.message : error}`,
        );
      });
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

/**
 * Poll pathname snapshots instead of retaining inode subscriptions. This avoids
 * fs.watch descriptor limits/async EMFILE and reconciles atomic replacement,
 * missing paths and directory creation equally on Node and Bun.
 */
function pollPaths(
  snapshot: () => Map<string, string>,
  onChange: (path: string) => void,
): WatchHandle {
  let previous = snapshot();
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed) return;
    let next: Map<string, string>;
    try {
      next = snapshot();
    } catch (error) {
      console.error(
        `[dev] watch reconciliation failed; retrying: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }
    const changed = new Set([...previous.keys(), ...next.keys()]);
    const before = previous;
    previous = next;
    for (const path of changed) {
      if (disposed) break;
      if (before.get(path) !== next.get(path)) onChange(path);
    }
  }, 100);
  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function snapshotPath(path: string, files: Map<string, string>, recursive: boolean): void {
  try {
    const stat = lstatSync(path);
    // Do not follow symlinks out of the source tree or enter directory cycles.
    files.set(
      path,
      stat.isDirectory()
        ? `directory:${stat.ino}`
        : `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    );
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git')
        continue;
      const child = join(path, entry.name);
      if (recursive || !entry.isDirectory()) snapshotPath(child, files, recursive);
      else {
        const stat = lstatSync(child);
        files.set(child, `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    // A missing path remains in the subscription and is discovered next tick.
  }
}

/** Watches immediate children of directories, or individual pathnames. */
export function createFileWatch(specs: readonly FileWatchSpec[]): WatchHandle {
  const handles = specs.map((spec) =>
    pollPaths(
      () => {
        const snapshot = new Map<string, string>();
        snapshotPath(resolve(spec.path), snapshot, false);
        return snapshot;
      },
      (path) => spec.onChange(path, relative(resolve(spec.path), path) || undefined),
    ),
  );
  return {
    dispose() {
      for (const handle of handles) handle.dispose();
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
  return pollPaths(() => {
    const snapshot = new Map<string, string>();
    snapshotPath(resolve(root), snapshot, true);
    return snapshot;
  }, onChange);
}
