import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type WatchLoop = {
  run(reason: string, force?: boolean): Promise<void>;
  schedule(reason: string): void;
  dispose(): void;
};

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
