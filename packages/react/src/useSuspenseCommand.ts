import type { InvokeOptions } from '@rustra/types';
import { resolveCommandId } from '@rustra/types';
import { useRustraEngine } from './context.js';
import type { CommandFn, VoidCommandFn } from './useCommand.js';
import { inputKey } from './input-key.js';

/**
 * Cache entry state machine — `pending` until the in-flight promise settles,
 * then `fulfilled` (value stored) or `rejected` (error stored).
 */
export interface SuspenseEntry<O = unknown> {
  promise: Promise<O>;
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: O;
  error?: unknown;
}

/**
 * Module-level suspense cache, keyed by `` `${commandName}::${inputKey(input) ?? ''}` ``.
 *
 * No eviction policy by design (YAGNI) — entries live for the session.
 */
const cache = new Map<string, SuspenseEntry>();

function cacheKey(commandName: string, input: unknown): string {
  return `${commandName}::${input === undefined ? '' : inputKey(input)}`;
}

/**
 * Pure cache state machine: returns the existing entry for `key` when present,
 * otherwise creates one by invoking `start()` and drives it to its terminal
 * state. Settling updates the entry in place, so later accessors read the
 * cached value/error without re-invoking.
 *
 * Exported for testing — the hook stays thin, and this is testable without
 * React (a thrown promise is awkward to exercise under SSR renderToString).
 */
export function resolveSuspenseEntry<O>(key: string, start: () => Promise<O>): SuspenseEntry<O> {
  const existing = cache.get(key);
  if (existing) return existing as SuspenseEntry<O>;

  const promise = start();
  const entry: SuspenseEntry<O> = { promise, status: 'pending' };
  cache.set(key, entry);

  promise.then(
    (value) => {
      entry.status = 'fulfilled';
      entry.value = value;
    },
    (err: unknown) => {
      entry.status = 'rejected';
      entry.error = err;
    },
  );
  return entry;
}

/**
 * Invalidate cached suspense entries.
 *
 * - `invalidateCommands('getItem')` — drop only that command's entries.
 * - `invalidateCommands()` — drop every cached entry.
 *
 * Works outside components (module-level cache), e.g. after a mutation.
 */
export function invalidateCommands(commandName?: string): void {
  if (commandName === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${commandName}::`)) cache.delete(key);
  }
}

/**
 * Suspense-compatible command hook. Must be called under a Suspense boundary.
 *
 * First call starts the invocation and throws the in-flight promise (React 18
 * `use` / React 19 Suspense contract); once settled, subsequent calls return
 * the cached value. A rejected invocation re-throws the same error object on
 * every access (error boundary contract) until `invalidateCommands` clears it.
 */
export function useSuspenseCommand<I, O>(
  commandFn: CommandFn<I, O> | VoidCommandFn<O>,
  input?: I,
  options?: InvokeOptions,
): O {
  const engine = useRustraEngine();
  // minify-안전 식별: 코드젠이 심은 commandId 를 우선한다 (Function.name 은
  // 프로덕션 번들러 mangling 으로 바뀔 수 있다).
  const commandName = resolveCommandId(commandFn);
  const entry = resolveSuspenseEntry<O>(cacheKey(commandName, input), () =>
    engine.invoke<O>(commandName, input, options),
  );

  if (entry.status === 'pending') throw entry.promise;
  if (entry.status === 'rejected') throw entry.error;
  return entry.value as O;
}
