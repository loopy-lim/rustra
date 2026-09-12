import { useState, useCallback, useEffect, useInsertionEffect, useMemo } from 'react';
import type { InvokeOptions } from '@rustra/types';
import { resolveCommandId } from '@rustra/types';
import { useRustraEngine } from './context.js';
import type { CommandFn, VoidCommandFn } from './useCommand.js';

export interface UseMutationOptions<I, O> {
  onSuccess?: (data: O, input: I) => void;
  onError?: (error: Error, input: I) => void;
  onSettled?: (data: O | undefined, error: Error | null, input: I) => void;
}

export interface UseMutationResult<I, O> {
  mutate: (input: I) => void;
  mutateAsync: (input: I, options?: InvokeOptions) => Promise<O>;
  data: O | undefined;
  loading: boolean;
  error: Error | null;
  reset: () => void;
}

export function useMutation<I = void, O = unknown>(
  commandFn: CommandFn<I, O> | VoidCommandFn<O>,
  options?: UseMutationOptions<I, O>,
): UseMutationResult<I, O> {
  const engine = useRustraEngine();
  const commandName = resolveCommandId(commandFn);
  // Each engine/command pair owns its counters and callback snapshot. Retained
  // async functions cannot borrow a replacement scope's callbacks or state.
  const scope = useMemo(
    () => ({
      engine,
      commandName,
      active: true,
      generation: 0,
      latestCall: 0,
      pendingCalls: 0,
      options: undefined as UseMutationOptions<I, O> | undefined,
    }),
    [engine, commandName],
  );
  const emptyState = {
    scope,
    data: undefined as O | undefined,
    loading: false,
    error: null as Error | null,
  };
  const [state, setState] = useState(emptyState);
  if (state.scope !== scope) setState(emptyState);

  // Publish only committed options, before any descendant layout effect can
  // invoke the stable mutation function. Render-time writes leak aborted renders.
  useInsertionEffect(() => {
    scope.options = options;
  }, [scope, options]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      scope.generation += 1;
      scope.pendingCalls = 0;
    };
  }, [scope]);

  const mutateAsync = useCallback(
    async (input: I, invokeOptions?: InvokeOptions): Promise<O> => {
      const generation = scope.generation;
      const callId = ++scope.latestCall;
      const callbacks = scope.options;
      const isCurrent = () => scope.active && scope.generation === generation;
      const update = (changes: Partial<typeof emptyState>) => {
        if (!isCurrent()) return;
        setState((current) => (current.scope === scope ? { ...current, ...changes } : current));
      };
      scope.pendingCalls += 1;
      update({ loading: true, error: null });
      let result: O;
      try {
        result = await scope.engine.invoke<O>(scope.commandName, input, invokeOptions);
      } catch (err: unknown) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        if (scope.latestCall === callId) update({ error: parsedError });
        callbacks?.onError?.(parsedError, input);
        callbacks?.onSettled?.(undefined, parsedError, input);
        throw parsedError;
      } finally {
        if (isCurrent()) {
          scope.pendingCalls = Math.max(0, scope.pendingCalls - 1);
          update({ loading: scope.pendingCalls > 0 });
        }
      }
      if (scope.latestCall === callId) update({ data: result });
      callbacks?.onSuccess?.(result, input);
      callbacks?.onSettled?.(result, null, input);
      return result;
    },
    [scope],
  );

  const mutate = useCallback(
    (input: I) => {
      mutateAsync(input).catch(() => {
        // Handled in mutateAsync state & onError callback
      });
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    scope.generation += 1;
    scope.pendingCalls = 0;
    setState((current) =>
      current.scope === scope ? { scope, data: undefined, error: null, loading: false } : current,
    );
  }, [scope]);

  const current = state.scope === scope ? state : emptyState;
  return {
    mutate,
    mutateAsync,
    data: current.data,
    loading: current.loading,
    error: current.error,
    reset,
  };
}
