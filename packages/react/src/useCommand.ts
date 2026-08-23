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

  // input 의 실행 키 — 값 동등성(직렬화)으로 판정한다. 인라인 객체 리터럴
  // (`useCommand(cmd, { a: 1 })`)은 렌더마다 새 참조라 참조 동등성을 쓰면
  // execute 재생성 → effect 재실행 → 상태 갱신 → 재렌더의 무한 루프가
  // 발생한다. invoke 에는 항상 원본 input 을 그대로 넘긴다.
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInputRef = useRef<{ key: string | undefined; value: I } | null>(null);
  if (stableInputRef.current === null || stableInputRef.current.key !== inputKey) {
    stableInputRef.current = { key: inputKey, value: input as I };
  }
  const stableInput = stableInputRef.current.value;

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
      const res = await engine.invoke<O>(commandName, stableInput, { signal: ac.signal });
      if (!ac.signal.aborted && isCurrent()) {
        setData(res);
      }
      return res;
    } catch (err: unknown) {
      if (!ac.signal.aborted && isCurrent()) {
        const parsedError = err instanceof Error ? err : new Error(String(err));
        setError(parsedError);
      }
      return undefined;
    } finally {
      // Always execute the state transition in finally. A stale/aborted request
      // preserves the current generation's loading state instead of clearing it.
      setLoading((current) => (!ac.signal.aborted && isCurrent() ? false : current));
    }
  }, [engine, commandName, stableInput]);

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
