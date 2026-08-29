import { useState, useEffect, useCallback, useRef } from 'react';
import type { InvokeOptions } from '@rustra/types';
import { resolveCommandId } from '@rustra/types';
import { useRustraEngine } from './context.js';
import { inputKey } from './input-key.js';

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
  //
  // 구현: render 중 ref.current 를 쓰지 않는다(React 19 동시성 금지 —
  // react-doctor/no-ref-current-in-render). useState 의 "이전 값과 같으면
  // 같은 참조 반환" 관례로 안정화한다: 키가 직전과 같으면 직전 state 를
  // 그대로 돌려받고, 다르면 setState 로 커밋 시점에 갱신한다.
  const serializedInput = input === undefined ? undefined : inputKey(input);
  const [stableInputBox, setStableInputBox] = useState<{
    key: string | undefined;
    value: I;
  }>(() => ({ key: serializedInput, value: input as I }));
  if (stableInputBox.key !== serializedInput) {
    setStableInputBox({ key: serializedInput, value: input as I });
  }
  const stableInput = stableInputBox.key === serializedInput ? stableInputBox.value : input;

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
