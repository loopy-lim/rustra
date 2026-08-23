import { useState, useEffect, useCallback, useRef } from 'react';
import type { InvokeOptions } from '@rustra/types';
import { resolveCommandId } from '@rustra/types';
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
  // settled ref — cleanup(abort) 와 응답 도착 사이의 미세 경쟁에서 이미 정리된
  // 실행이 상태를 건드리지 못하게 한다. 세대 카운터가 execute 실행마다 증가해
  // stale 실행의 setState 를 전부 가드한다(StrictMode 이중 마운트 포함).
  const generationRef = useRef(0);
  // minify-안전 식별: 코드젠이 심은 commandId 를 우선한다 (Function.name 은
  // 프로덕션 번들러 mangling 으로 바뀔 수 있다).
  const commandName = resolveCommandId(commandFn);

  const execute = useCallback(async (): Promise<O | undefined> => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;

    setLoading(true);
    setError(null);

    try {
      const res = await engine.invoke<O>(commandName, input, { signal: ac.signal });
      if (!ac.signal.aborted && isCurrent()) {
        setData(res);
        setLoading(false);
      }
      return res;
    } catch (err: unknown) {
      if (!ac.signal.aborted && isCurrent()) {
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
      // 세대 무효화 — unmount/re-run 시 진행 중 실행의 setState 를 막는다.
      generationRef.current += 1;
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
