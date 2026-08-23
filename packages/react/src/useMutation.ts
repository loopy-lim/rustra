import { useState, useCallback, useRef } from 'react';
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
  optionsRef.current = options;

  const mutateAsync = useCallback(
    async (input: I, invokeOptions?: InvokeOptions): Promise<O> => {
      setLoading(true);
      setError(null);

      try {
        const res = await engine.invoke<O>(commandName, input, invokeOptions);
        setData(res);
        setLoading(false);
        optionsRef.current?.onSuccess?.(res, input);
        optionsRef.current?.onSettled?.(res, null, input);
        return res;
      } catch (err: unknown) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        setError(parsedError);
        setLoading(false);
        optionsRef.current?.onError?.(parsedError, input);
        optionsRef.current?.onSettled?.(undefined, parsedError, input);
        throw parsedError;
      }
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
