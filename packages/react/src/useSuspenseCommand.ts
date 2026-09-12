import type { InvokeOptions } from '@rustra/types';
import { resolveCommandId } from '@rustra/types';
import { useRustraEngine } from './context.js';
import type { CommandFn, VoidCommandFn } from './useCommand.js';
import { inputKey } from './input-key.js';
import { resolveSuspenseEntry } from './suspense-cache.js';

export {
  resolveSuspenseEntry,
  invalidateCommands,
  configureSuspenseCache,
} from './suspense-cache.js';
export type { SuspenseEntry, SuspenseCacheOptions } from './suspense-cache.js';

/**
 * Suspends until an engine-scoped command result is ready. Inputs are structurally
 * keyed; options apply only to the first invocation of a cached key. Rejected
 * results reach the nearest error boundary until invalidation or expiry.
 */
export function useSuspenseCommand<I, O>(
  commandFn: CommandFn<I, O> | VoidCommandFn<O>,
  input?: I,
  options?: InvokeOptions,
): O {
  const engine = useRustraEngine();
  const commandName = resolveCommandId(commandFn);
  const entry = resolveSuspenseEntry<O>(
    JSON.stringify([commandName, inputKey(input)]),
    commandName,
    () => engine.invoke<O>(commandName, input, options),
    engine,
  );
  if (entry.status === 'pending') throw entry.promise;
  if (entry.status === 'rejected') throw entry.error;
  return entry.value as O;
}
