import type { EngineClient } from '@rustra/types';
import { getDefaultEngine } from './context.js';

export interface SuspenseEntry<O = unknown> {
  commandName: string;
  promise: Promise<O>;
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: O;
  error?: unknown;
}

export interface SuspenseCacheOptions {
  /** Maximum total entries per engine. Default: 256. */
  maxEntries?: number;
  /** Retention after settlement, in milliseconds. Default: 300000 (5 minutes). */
  ttlMs?: number;
  /** Maximum time a cached request can remain pending. Default: 30000. */
  pendingTimeoutMs?: number;
}

type Policy = Required<SuspenseCacheOptions>;
type RecordEntry = {
  entry: SuspenseEntry;
  expiresAt: number;
  expiry?: ReturnType<typeof setTimeout>;
};
type Cache = { entries: Map<string, RecordEntry>; policy: Policy };
const defaults: Policy = { maxEntries: 256, ttlMs: 300_000, pendingTimeoutMs: 30_000 };
const caches = new WeakMap<EngineClient, Cache>();
// Weak references preserve the legacy cross-engine invalidation API without
// retaining an engine (or its data) after its owner is gone.
const liveCaches = new Set<WeakRef<Cache>>();

function getCache(engine: EngineClient): Cache {
  let cache = caches.get(engine);
  if (!cache) {
    cache = { entries: new Map(), policy: { ...defaults } };
    caches.set(engine, cache);
    for (const reference of liveCaches) if (!reference.deref()) liveCaches.delete(reference);
    liveCaches.add(new WeakRef(cache));
  }
  return cache;
}

function remove(cache: Cache, key: string): void {
  const record = cache.entries.get(key);
  if (record?.expiry) clearTimeout(record.expiry);
  cache.entries.delete(key);
}

function invalidate(cache: Cache, commandName?: string): void {
  for (const [key, record] of cache.entries) {
    if (commandName === undefined || record.entry.commandName === commandName) remove(cache, key);
  }
}

/** Configure one engine's finite cache policy and discard its existing entries. */
export function configureSuspenseCache(
  options: SuspenseCacheOptions,
  engine = getDefaultEngine(),
): void {
  const policy = { ...defaults, ...options };
  for (const [name, value] of Object.entries(policy)) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      (name !== 'maxEntries' && value > 2_147_483_647)
    ) {
      throw new RangeError(
        `Rustra suspense cache ${name} must be a positive safe integer within timer limits`,
      );
    }
  }
  const cache = getCache(engine);
  invalidate(cache);
  cache.policy = policy;
}

/** With an engine, invalidate only that scope; without one, all live scopes. */
export function invalidateCommands(commandName?: string, engine?: EngineClient): void {
  if (engine) {
    const cache = caches.get(engine);
    if (cache) invalidate(cache, commandName);
    return;
  }
  for (const reference of liveCaches) {
    const cache = reference.deref();
    if (cache) invalidate(cache, commandName);
    else liveCaches.delete(reference);
  }
}

export function resolveSuspenseEntry<O>(
  key: string,
  commandName: string,
  start: () => Promise<O>,
  engine: EngineClient = getDefaultEngine(),
): SuspenseEntry<O> {
  const cache = getCache(engine);
  const now = Date.now();
  for (const [candidate, record] of cache.entries) {
    if (record.entry.status !== 'pending' && record.expiresAt <= now) remove(cache, candidate);
  }
  const existing = cache.entries.get(key);
  if (existing) {
    cache.entries.delete(key);
    cache.entries.set(key, existing);
    return existing.entry as SuspenseEntry<O>;
  }
  if (cache.entries.size >= cache.policy.maxEntries) {
    const evictable = [...cache.entries].find(([, record]) => record.entry.status !== 'pending');
    if (evictable) remove(cache, evictable[0]);
    else throw new Error('Rustra suspense cache capacity reached while all requests are pending');
  }

  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Rustra suspense command timed out')),
      cache.policy.pendingTimeoutMs,
    );
  });
  let invocation: Promise<O>;
  try {
    invocation = start();
  } catch (error) {
    invocation = Promise.reject(error);
  }
  const promise = Promise.race([invocation, deadline]);
  const entry: SuspenseEntry<O> = { commandName, promise, status: 'pending' };
  const record: RecordEntry = { entry, expiresAt: Infinity };
  cache.entries.set(key, record);

  function settled(): void {
    clearTimeout(timeout);
    // Invalidated requests still settle for their callers but never reinsert.
    if (cache.entries.get(key) !== record) return;
    record.expiresAt = Date.now() + cache.policy.ttlMs;
    record.expiry = setTimeout(() => remove(cache, key), cache.policy.ttlMs);
    // Node SSR must not remain alive solely for cache retention.
    (record.expiry as { unref?: () => void }).unref?.();
  }
  promise.then(
    (value) => {
      entry.status = 'fulfilled';
      entry.value = value;
      settled();
    },
    (error: unknown) => {
      entry.status = 'rejected';
      entry.error = error instanceof Error ? error : new Error(String(error));
      settled();
    },
  );
  return entry;
}
