import { useState, useCallback, useEffect, useRef } from 'react';
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
  const [data, setData] = useState<O | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  // minify-안전 식별: 코드젠이 심은 commandId 를 우선한다 (Function.name 은
  // 프로덕션 번들러 mangling 으로 바뀔 수 있다).
  const commandName = resolveCommandId(commandFn);
  const optionsRef = useRef(options);
  const latestCallRef = useRef(0);
  const pendingCallsRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const mutateAsync = useCallback(
    async (input: I, invokeOptions?: InvokeOptions): Promise<O> => {
      const generation = generationRef.current;
      const callId = ++latestCallRef.current;
      pendingCallsRef.current += 1;
      setLoading(true);
      setError(null);

      let result: O;
      try {
        result = await engine.invoke<O>(commandName, input, invokeOptions);
      } catch (err: unknown) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        if (generationRef.current === generation && latestCallRef.current === callId) {
          setError(parsedError);
        }
        optionsRef.current?.onError?.(parsedError, input);
        optionsRef.current?.onSettled?.(undefined, parsedError, input);
        throw parsedError;
      } finally {
        if (generationRef.current === generation) {
          pendingCallsRef.current = Math.max(0, pendingCallsRef.current - 1);
          setLoading(pendingCallsRef.current > 0);
        }
      }

      if (generationRef.current === generation && latestCallRef.current === callId) {
        setData(result);
      }
      optionsRef.current?.onSuccess?.(result, input);
      optionsRef.current?.onSettled?.(result, null, input);
      return result;
    },
    [engine, commandName],
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
    generationRef.current += 1;
    pendingCallsRef.current = 0;
    setData(undefined);
    setError(null);
    setLoading(false);
  }, []);

  return {
    mutate,
    mutateAsync,
    data,
    loading,
    error,
    reset,
  };
}
