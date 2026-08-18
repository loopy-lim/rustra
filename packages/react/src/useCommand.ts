import { useState, useEffect, useCallback, useRef } from 'react';
import type { InvokeOptions } from '@rustra/types';
import { useRustraEngine } from './context.js';

export type CommandFn<I, O> = (input: I, options?: InvokeOptions) => Promise<O>;
export type VoidCommandFn<O> = (options?: InvokeOptions) => Promise<O>;

export interface UseCommandOptions {
  /** If false, query will not run automatically. Default: true */
  enabled?: boolean;
}

export interface UseCommandResult<O> {
  data: O | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<O | undefined>;
}

export function useCommand<I, O>(
  commandFn: CommandFn<I, O> | VoidCommandFn<O>,
  input?: I,
  options?: UseCommandOptions,
): UseCommandResult<O> {
  const engine = useRustraEngine();
  const [data, setData] = useState<O | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(options?.enabled ?? true);
  const [error, setError] = useState<Error | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const commandName = commandFn.name;

  const execute = useCallback(async (): Promise<O | undefined> => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;

    setLoading(true);
    setError(null);

    try {
      const res = await engine.invoke<O>(commandName, input, { signal: ac.signal });
      if (!ac.signal.aborted) {
        setData(res);
        setLoading(false);
      }
      return res;
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        setError(parsedError);
        setLoading(false);
      }
      return undefined;
    }
  }, [engine, commandName, JSON.stringify(input)]);

  useEffect(() => {
    if (options?.enabled === false) {
      setLoading(false);
      return;
    }
    execute();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [execute, options?.enabled]);

  return {
    data,
    loading,
    error,
    refetch: execute,
  };
}
