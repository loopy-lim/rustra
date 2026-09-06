import type { BatchEntry, EngineClient as EngineClientType, InvokeOptions } from '@rustra/types';
import {
  CancelledError,
  invokeCallbackWithAbort,
  invokeWithTimeoutHandledSignal,
  parseRustraErrorString,
} from '@rustra/types';
import {
  createFastEngine,
  type FastEngineOptions,
  type ReactNativeEngine,
  type RustraJSINative,
} from './react-native-core.js';

export type RustraJSIAsyncNative = RustraJSINative & {
  invokeTypedAsync?(
    name: string,
    args: unknown,
    onSuccess: (result: unknown) => void,
    onError: (message: string) => void,
  ): number | void;
  /**
   * (G2) id 인덱싱 async 진입 — 이름 문자열 마샬링 제거. 정적 명령(코드젠
   * registry 안)은 byId 우선, 미노출 또는 registry 밖 동적 명령은 이름 경로
   * 폴백(P0-3 sync byId 패턴과 동일 계약).
   */
  invokeTypedAsyncById?(
    commandId: number,
    args: unknown,
    onSuccess: (result: unknown) => void,
    onError: (message: string) => void,
  ): number | void;
  invokeCancel?(invocationId: number): boolean;
};

export function createAsyncEngine(
  native: RustraJSIAsyncNative,
  options: FastEngineOptions,
): ReactNativeEngine {
  const syncEngine = createFastEngine(native, options);
  if (typeof native.invokeTypedAsync !== 'function') {
    console.warn(
      '[rustra/react-native] createAsyncEngine is using the synchronous fallback; rebuild the native module with invokeTypedAsync for JS-thread offload.',
    );
    return syncEngine;
  }
  const invokeTypedAsync = native.invokeTypedAsync.bind(native);
  // G2 — 정적 id 캐시 (ensureStaticIds 선례): registry 기준 1회 스윕.
  // registry 에 있는 이름 = 코드젠 정적 명령 = C++ encode_by_id 로 접근 가능.
  const hasByIdPath = typeof native.invokeTypedAsyncById === 'function';
  const invokeTypedAsyncById = hasByIdPath ? native.invokeTypedAsyncById!.bind(native) : null;
  const staticIds = new Map<string, number>();
  if (hasByIdPath) {
    for (const [name, codec] of options.rkyvV2Codecs) {
      staticIds.set(name, codec.commandId);
    }
  }
  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      const signal = invokeOptions?.signal;
      if (signal?.aborted)
        return Promise.reject(new CancelledError(`invoke("${command}") aborted before dispatch`));
      const staticId = hasByIdPath ? staticIds.get(command) : undefined;
      const dispatch = (
        resolve: (value: T) => void,
        reject: (reason: unknown) => void,
      ): number | void =>
        staticId !== undefined
          ? invokeTypedAsyncById!(
              staticId,
              args,
              (result) => resolve(result as T),
              (message) => reject(parseRustraErrorString(message)),
            )
          : invokeTypedAsync(
              command,
              args,
              (result) => resolve(result as T),
              (message) => reject(parseRustraErrorString(message)),
            );
      if (!signal) {
        return new Promise<T>((resolve, reject) => {
          void dispatch(resolve, reject);
        });
      }
      return invokeCallbackWithAbort<T>(
        command,
        signal,
        (resolve, reject) => dispatch(resolve, reject),
        typeof native.invokeCancel === 'function' ? (id) => native.invokeCancel!(id) : undefined,
      );
    },
  };
  const engine: ReactNativeEngine = {
    // A02 — async 엔진은 sync rkyv V2 엔진과 동일한 매트릭스 셀을 공유한다
    // (취소는 invokeCancel 노출 시 전파 — 존재는 위 transport 경로가 판별).
    supports: syncEngine.supports,
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      return invokeWithTimeoutHandledSignal<T>(transport, command, args, invokeOptions);
    },
    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      return Promise.all(
        entries.map((entry) => engine.invoke<T>(entry.command, entry.args, entry.options)),
      );
    },
  };
  return engine;
}
