import type {
  BatchEntry,
  BootstrapState,
  EngineClient as EngineClientType,
  EngineSupports,
  InvokeOptions,
  RkyvV2Engine,
  RkyvV2EngineOptions,
  RkyvV2SchemaNative,
  RustraNative,
} from '@rustra/types';
import {
  CancelledError,
  configureLazy,
  createRkyvV2Engine,
  decodeUtf8,
  disposedBootstrapError,
  encodeUtf8,
  ensureConfigured,
  exactArrayBuffer,
  invokeWithTimeout,
  parseRustraErrorString,
  raceAbort,
} from '@rustra/types';

export type ReactNativeEngine = EngineClientType & {
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
};
export type RustraJSINative = RkyvV2SchemaNative & {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  drainEvents?(): number;
  createChannel?(callback: (payloadJson: string) => void): number;
  dropChannel?(handle: number): boolean;
};

/**
 * RN JSON 어댑터의 기술적 지표(A02) — compatibility-matrix.md 의 RN
 * `createReactNativeEngine` 열 셀을 그대로 옮긴 것: in-flight 취소는 얕은
 * 취소(JS 프라미스만 거부), 배치는 per-entry 폴백, 이벤트 미지원(❌ JSON
 * adapter), 채널은 JSI handle + close(), 동기 native 호출은 실행 중 선점 불가
 * (timeoutMs 레이스 없음 — 유일한 false 셀).
 */
export const REACT_NATIVE_JSON_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'shallow',
  batch: 'per-entry',
  events: 'none',
  channels: true,
  timeoutPreemption: false,
};

/**
 * RN rkyv V2 엔진의 기술적 지표(A02) — compatibility-matrix.md 의 RN
 * `createRkyvV2Engine` 열 셀을 그대로 옮긴 것: 취소는 조건부 전파(JS 코덱 +
 * invokeAsync/invokeCancel 확인 시 Rust 체크포인트까지 — 정적 typed 경로는
 * 얕은 취소 폴백), 배치는 정적 명령 단일 횡단(signal 항목은 항목별 라우팅),
 * 이벤트 푸시(CallInvoker 자동 drain), 채널 JSI handle, timeoutMs 레이스 있음.
 */
export const REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'cooperative',
  batch: 'single-crossing',
  events: 'push',
  channels: true,
  timeoutPreemption: true,
};

export function createReactNativeEngine(native: {
  invoke(payload: ArrayBuffer): ArrayBuffer;
}): ReactNativeEngine {
  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      if (options?.signal?.aborted) {
        return Promise.reject(new CancelledError(`invoke("${command}") aborted before dispatch`));
      }
      try {
        const payload = exactArrayBuffer(encodeUtf8(JSON.stringify({ command, args })));
        const response = JSON.parse(decodeUtf8(native.invoke(payload))) as {
          ok: boolean;
          result?: T;
          error?: string;
        };
        if (!response.ok) return Promise.reject(parseRustraErrorString(response.error));
        const result = Promise.resolve(response.result as T);
        return options?.signal ? raceAbort(result, options.signal, command) : result;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return {
    supports: { ...REACT_NATIVE_JSON_ENGINE_SUPPORTS },
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions) {
      return invokeWithTimeout<T>(transport, command, args, options);
    },
    invokeBatch<T>(entries: BatchEntry[]) {
      return Promise.all(
        entries.map((entry) =>
          invokeWithTimeout<T>(transport, entry.command, entry.args, entry.options),
        ),
      );
    },
  };
}

export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, import('@rustra/types').RkyvV2Codec<unknown, unknown>>;
} & RkyvV2EngineOptions;
export type RustraBootstrapOptions = FastEngineOptions & {
  install(): Promise<void>;
  getNative(): RustraJSINative;
};
export type RustraBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 공용 `BootstrapState`(@rustra/types).
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: BootstrapState;
  ready(): Promise<RkyvV2Engine>;
  /** (A05) dispose-once — 두 번째 호출은 no-op. JS reload 는 네이티브 drift 를 못 고친다. */
  dispose(): void;
};

export function createRustraBootstrap(options: RustraBootstrapOptions): RustraBootstrap {
  let state: BootstrapState = 'initializing';
  const disposed = () =>
    disposedBootstrapError(
      'Rustra (React Native)',
      'A JS reload cannot repair native drift — remount the React Native screen/app to create a fresh bootstrap.',
    );
  configureLazy(async () => {
    try {
      await options.install();
      return createFastEngine(options.getNative(), options);
    } catch (error) {
      throw new Error(
        `[rustra:bootstrap] Native setup failed: ${error instanceof Error ? error.message : String(error)}. Rebuild the native app after checking autolinking, generated codecs, and Rust FFI symbols.`,
        { cause: error },
      );
    }
  });
  const dispose = () => {
    if (state === 'disposed') return; // dispose-once 멱등 — 두 번째는 no-op
    state = 'disposed';
  };
  return {
    get state() {
      return state;
    },
    ready: () => {
      if (state === 'disposed') return Promise.reject(disposed());
      return (ensureConfigured() as Promise<RkyvV2Engine>).then((engine) => {
        if (state === 'disposed') throw disposed();
        state = 'ready';
        return engine;
      });
    },
    dispose,
  };
}

export function getRustraNative(): RustraJSINative & RustraNative {
  const native = (globalThis as Record<string, unknown>).__rustraNative;
  if (!native) {
    throw new Error(
      'JSI native module not installed. Call installRustraJSI() from your native module first. ' +
        'Expo Go cannot load JSI; rebuild the native app after checking autolinking, the Rust static archive, ' +
        'and required extern "C" FFI symbols. A JavaScript reload cannot repair native drift.',
    );
  }
  return native as RustraJSINative & RustraNative;
}

export function createFastEngine(
  native: RustraJSINative,
  options: FastEngineOptions,
): RkyvV2Engine {
  const engineOptions = {
    contractHash: options.contractHash,
    onContractMismatch: options.onContractMismatch,
    schemaVersion: options.schemaVersion,
    onSchemaStale: options.onSchemaStale,
    maxPayloadBytes: options.maxPayloadBytes,
  } satisfies RkyvV2EngineOptions;
  const engine = createRkyvV2Engine(native, options.rkyvV2Codecs, engineOptions);
  engine.supports = { ...REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS };
  return engine;
}
