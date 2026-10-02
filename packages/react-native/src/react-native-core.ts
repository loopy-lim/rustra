import type {
  BatchEntry,
  BootstrapState,
  EngineClient as EngineClientType,
  EngineSupports,
  InvokeOptions,
  FrameEngine,
  FrameEngineOptions,
  FrameSchemaNative,
  RustraNative,
} from '@rustra/types';
import {
  CancelledError,
  configureLazy,
  createFrameEngine,
  decodeUtf8,
  disposedBootstrapError,
  encodeUtf8,
  ensureConfigured,
  exactArrayBuffer,
  invokeWithTimeout,
  parseRustraErrorString,
  raceAbort,
  RustraCommandError,
  RustraErrorCode,
} from '@rustra/types';

export type ReactNativeEngine = EngineClientType & {
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
};
export type RustraJSINative = FrameSchemaNative & {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  /** JS 폴링 drain(CallInvoker 없는 호스트). 처리된 이벤트+채널 프레임 수 반환. */
  drainEvents?(): number;
  createChannel?(callback: (payloadJson: string) => void): number;
  /** 바이너리 채널 — 콜백이 Frame 프레임 등 임의 바이트를 받는다. */
  createChannelBytes?(callback: (payload: ArrayBuffer | Uint8Array) => void): number;
  dropChannel?(handle: number): boolean;
  /** Producer-bound close; preserves channel ownership across hot-core replacement. */
  bindChannelClose?(handle: number): () => boolean;
  /**
   * C++ typed fast path(동기) — HostFunction `invokeTyped` 과 동일 계약.
   * 동기 invoke 표면(`invokeTypedSync`) 이 이 함수를 직접 쓴다. 에러는
   * `"code: message"` 문자열 JSError 로 던져진다(변환은 어댑터가 담당).
   */
  invokeTyped?(name: string, args: unknown): unknown;
  /**
   * dev 핫코어 상태 — dylib 스왑 관측(dev 전용, iOS 시뮬레이터 스코프).
   * 정적 모드(비활성 또는 구형 네이티브)는 null. 핫 모드는 마지막 성공 스왑의
   * 구/신 코어 계약 해시와 마지막 실패 사유를 실는다.
   */
  hotCoreStatus?(): {
    enabled: boolean;
    swapped: boolean;
    oldHash: string;
    newHash: string;
    error: string;
  } | null;
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
 * RN Frame 엔진의 기술적 지표(A02) — compatibility-matrix.md 의 RN
 * `createFrameEngine` 열 셀을 그대로 옮긴 것: 취소는 조건부 전파(JS 코덱 +
 * invokeAsync/invokeCancel 확인 시 Rust 체크포인트까지 — 정적 typed 경로는
 * 얕은 취소 폴백), 배치는 정적 명령 단일 횡단(signal 항목은 항목별 라우팅),
 * 이벤트 푸시(CallInvoker 자동 drain), 채널 JSI handle, timeoutMs 레이스 있음.
 */
export const REACT_NATIVE_FRAME_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'cooperative',
  batch: 'single-crossing',
  events: 'push',
  channels: true,
  timeoutPreemption: true,
};

export function createReactNativeEngine(native: {
  invoke(payload: ArrayBuffer): ArrayBuffer;
}): ReactNativeEngine {
  assertNativeTransport(native, 'createReactNativeEngine', 'invoke');
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
  frameCodecs: Map<string, import('@rustra/types').FrameCodec<unknown, unknown>>;
} & FrameEngineOptions;
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
  ready(): Promise<FrameEngine>;
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
  const requireActive = () => {
    if (state === 'disposed') throw disposed();
    if (!registration.isCurrent()) {
      throw new RustraCommandError(
        RustraErrorCode.RegistryFrozen,
        'React Native bootstrap registration was replaced by another engine',
      );
    }
  };
  const registration = configureLazy(
    async () => {
      requireActive();
      try {
        await options.install();
        requireActive();
        return guardBootstrapEngine(createFastEngine(options.getNative(), options), requireActive);
      } catch (error) {
        requireActive();
        if (error instanceof RustraCommandError) throw error;
        throw new Error(
          `[rustra:bootstrap] Native setup failed: ${error instanceof Error ? error.message : String(error)}. Rebuild the native app after checking autolinking, generated codecs, and Rust FFI symbols.`,
          { cause: error },
        );
      }
    },
    { ownerId: 'React Native bootstrap' },
  );
  const dispose = () => {
    if (state === 'disposed') return; // dispose-once 멱등 — 두 번째는 no-op
    state = 'disposed';
    registration();
  };
  return {
    get state() {
      return state;
    },
    ready: () => {
      if (state === 'disposed') return Promise.reject(disposed());
      try {
        requireActive();
      } catch (error) {
        return Promise.reject(error);
      }
      return (ensureConfigured() as Promise<FrameEngine>)
        .then((engine) => {
          requireActive();
          state = 'ready';
          return engine;
        })
        .catch((error: unknown) => {
          requireActive();
          throw error;
        });
    },
    dispose,
  };
}

/** Retained engines and cached synchronous routes share the bootstrap lease. */
function guardBootstrapEngine(engine: FrameEngine, requireActive: () => void): FrameEngine {
  const guarded = { ...engine };
  for (const key of Reflect.ownKeys(engine)) {
    const member: unknown = Reflect.get(engine, key);
    if (typeof member !== 'function') continue;
    const returnsPromise = key === 'invoke' || key === 'invokeById' || key === 'invokeBatch';
    Reflect.set(guarded, key, (...args: unknown[]) => {
      try {
        requireActive();
      } catch (error) {
        if (returnsPromise) return Promise.reject(error);
        throw error;
      }
      const result: unknown = Reflect.apply(member, engine, args);
      // Internal Frame resolvers return cached native bindings; guarding only
      // the resolver would leave previously captured routes usable after dispose.
      if (typeof result === 'function') {
        return (...routeArgs: unknown[]) => {
          requireActive();
          return Reflect.apply(result, undefined, routeArgs);
        };
      }
      return result;
    });
  }
  return guarded;
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

export function createFastEngine(native: RustraJSINative, options: FastEngineOptions): FrameEngine {
  assertNativeTransport(native, 'createFastEngine', 'invokeFrame');
  const engineOptions = {
    contractHash: options.contractHash,
    contractVerification: options.contractVerification,
    onContractMismatch: options.onContractMismatch,
    schemaVersion: options.schemaVersion,
    onSchemaStale: options.onSchemaStale,
    maxPayloadBytes: options.maxPayloadBytes,
  } satisfies FrameEngineOptions;
  const engine = createFrameEngine(native, options.frameCodecs, engineOptions);
  engine.supports = { ...REACT_NATIVE_FRAME_ENGINE_SUPPORTS };
  return engine;
}

/** Check the selected transport before exposing a ready but unusable engine. */
function assertNativeTransport(
  native: unknown,
  engine: string,
  method: 'invoke' | 'invokeFrame',
): void {
  if (
    native !== null &&
    (typeof native === 'object' || typeof native === 'function') &&
    typeof Reflect.get(native, method) === 'function'
  )
    return;
  throw new RustraCommandError(
    'native.incompatible',
    `[rustra/react-native] ${engine} requires native.${method}(); the installed native bridge ` +
      'is incompatible with the selected engine. Regenerate the React Native bridge with ' +
      '`rustra codegen --config <path>`, rebuild the Rust archive and the native app, then ' +
      'await installRustraJSI() before creating the engine. A JavaScript reload cannot update native bindings.',
  );
}
