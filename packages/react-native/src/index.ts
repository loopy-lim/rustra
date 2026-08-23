/**
 * RN용 rustra 엔진 어댑터
 *
 * 글로벌 invoke + RN JSI 전용 엔진을 제공합니다.
 * 설정은 `@rustra/types`의 configure()를 사용합니다.
 */

import type {
  EngineClient as EngineClientType,
  InvokeOptions,
  RkyvV2EngineOptions,
  RkyvV2SchemaNative,
  RustraNative,
} from '@rustra/types';
import {
  createRkyvV2Engine,
  invokeWithTimeout,
  parseRustraErrorString,
  RustraCommandError,
} from '@rustra/types';
import { decodeUtf8, encodeUtf8, exactArrayBuffer } from './utf8.js';

export type {
  EngineClient,
  InvokeOptions,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  RkyvV2SchemaNative,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  invoke,
  createRkyvV2Engine,
  parseRustraErrorString,
} from '@rustra/types';

/**
 * RN JSI 네이티브 표면 — 코어 `RkyvV2SchemaNative` 를 그대로 상속하고 RN 전용
 * 메서드만 추가 선언한다. 과거엔 동일 메서드를 3곳(types의 RkyvV2SchemaNative,
 * RustraNative, 여기)에서 수동 미러링해 신규 옵션마다 세 곳을 동기화했었다 —
 * 이제 단일 소스(types)를 재사용한다.
 */
export type RustraJSINative = RkyvV2SchemaNative & {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  /**
   * Rust → JS 이벤트 푸시(RN JSI EventDispatcher). 콜백 인자는 JSON 문자열 —
   * `subscribeEvent` 래퍼가 파싱한다.
   */
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  /** CallInvoker 없는 호스트의 수동 drain 폴백. */
  drainEvents?(): number;
};

export function createReactNativeEngine(native: { invoke(payload: ArrayBuffer): ArrayBuffer }) {
  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      if (options?.signal?.aborted) {
        return Promise.reject(
          new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
        );
      }
      try {
        const json = JSON.stringify({ command, args });
        const payload = exactArrayBuffer(encodeUtf8(json));
        const resultBytes = native.invoke(payload);
        const resultJson = decodeUtf8(resultBytes);
        const response = JSON.parse(resultJson) as {
          ok: boolean;
          result?: T;
          error?: string;
        };
        if (!response.ok) {
          return Promise.reject(parseRustraErrorString(response.error));
        }
        const result = Promise.resolve(response.result as T);
        return options?.signal ? raceAbortShallow(result, options.signal, command) : result;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  return {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      return invokeWithTimeout(transport, command, args, options);
    },
  };
}

// ── Fast sync engine ──────────────────────────────────────────

/**
 * 동기 엔진 — JSI sync call로 Promise 오버헤드 없이 즉시 결과를 반환합니다.
 */
export type SyncEngineClient = {
  invoke<T>(command: string, args?: unknown): T;
};

/**
 * 고속 엔진 생성 옵션.
 *
 * rkyv V2 바이너리 경로를 필수로 사용합니다 (최고 성능). 나머지 필드는 core
 * `RkyvV2EngineOptions` 를 그대로 전달한다 — contractHash 검증(F5),
 * onContractMismatch/schemaVersion/onSchemaStale(OTA, T2), maxPayloadBytes(T3).
 */
export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, import('@rustra/types').RkyvV2Codec<unknown, unknown>>;
} & RkyvV2EngineOptions;

/**
 * 고속 엔진 — JSI 동기 호출로 Promise 오버헤드 없이 결과를 반환합니다.
 *
 * rkyv V2 바이너리 코덱을 통해 최고 성능의 동기 호출을 제공합니다.
 *
 * @example
 * ```ts
 * import { createFastEngine } from '@rustra/react-native';
 * import { registry } from './generated/rkyv-registry.js';
 *
 * const native = global.__rustraNative;
 * const engine = createFastEngine(native, { rkyvV2Codecs: registry });
 * configure(engine);
 * ```
 */
/**
 * 글로벌 JSI 네이티브 모듈에 접근합니다.
 *
 * JSI가 설치된 후 `global.__rustraNative`에서 네이티브 모듈을 가져옵니다.
 * 설치 전에 호출하면 에러를 던집니다.
 *
 * @example
 * ```ts
 * import { getRustraNative } from '@rustra/react-native';
 * const native = getRustraNative();
 * const engine = createFastEngine(native, { rkyvV2Codecs: registry });
 * ```
 */
export function getRustraNative(): RustraNative {
  const native = (globalThis as Record<string, unknown>).__rustraNative;
  if (!native) {
    throw new Error(
      'JSI native module not installed. Call installRustraJSI() from your native module first.',
    );
  }
  return native as RustraNative;
}

export function createFastEngine(
  native: RustraJSINative,
  options: FastEngineOptions,
): EngineClientType {
  // 명시 나열 + satisfies — core 에 옵션이 추가되면 이 객체 리터럴이 누락
  // 필드/오타를 타입 에러로 드러낸다 (수작업 필터링 누수 방지).
  const engineOptions = {
    contractHash: options.contractHash,
    onContractMismatch: options.onContractMismatch,
    schemaVersion: options.schemaVersion,
    onSchemaStale: options.onSchemaStale,
    maxPayloadBytes: options.maxPayloadBytes,
  } satisfies RkyvV2EngineOptions;
  return createRkyvV2Engine(native, options.rkyvV2Codecs, engineOptions);
}

// ── P0-3 async offload — invokeAsync ──────────────────────────

/**
 * P0-3 async offload용 네이티브 인터페이스 확장 (선택 구현).
 *
 * 네이티브가 `invokeTypedAsync(name, args, callback)`을 노출하면 전용 worker
 * 큐(또는 dispatch_async)에서 Rust 를 호출한 뒤 JS 콜백 큐로 직렬화한다 —
 * 긴 Rust 연산이 JS 스레드를 블록하지 않는다 (jank 방지).
 *
 * 네이티브 구현이 없으면 `invokeAsync` 는 동기 `invokeTyped` 로 폴백한다
 * (기능은 동일, 스레드 오프로드 없음).
 */
export type RustraJSIAsyncNative = RustraJSINative & {
  /**
   * 성공/에러 후 JS 콜백 큐에서 호출될 콜백 등록형 비동기 호출.
   *
   * 반환값: invocation id (취소 핸들, follow-up 3). 네이티브가 id 를
   * 노출하면 `invokeCancel(id)` 로 Rust 취소 체크포인트까지 전파된다.
   * 구형 네이티브가 undefined 를 반환하면 어댑터가 얕은 취소로 폴백한다.
   */
  invokeTypedAsync?(
    name: string,
    args: unknown,
    onSuccess: (result: unknown) => void,
    onError: (message: string) => void,
  ): number | void;
  /** 진행 중 async 호출 취소 — invokeTypedAsync 가 반환한 id. */
  invokeCancel?(invocationId: number): boolean;
};

/**
 * 얕은 취소 (T1) — 네이티브 전파가 불가능한 async 엔진 경로. JS 프라미스만
 * 즉시 거부하고 네이티브 콜백의 늦은 resolve/reject 는 무시한다.
 * `@rustra/types` 의 raceAbort 와 동일 계약의 로컬 헬퍼 — RN 패키지의 공개
 * API 면을 늘리지 않기 위해 내부에서만 사용한다.
 */
function raceAbortShallow<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  command: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 비동기 invoke — 무거운 Rust 연산을 JS 스레드에서 오프로드한다.
 *
 * - 네이티브 `invokeTypedAsync` 가 있으면: 즉시 반환( invocation id 포함),
 *   결과는 JS 콜백 큐로 전달.
 * - 없으면: 동기 fast path(`createFastEngine`)로 폴백 — 마이크로태스크로 래핑해
 *   API 계약(`Promise<T>`)은 항상 동일하게 유지.
 * - `options.signal` (T1): abort 시 `cancelled` 로 즉시 거부. 네이티브가
 *   `invokeCancel` 을 노출하면 id 로 **취소 전파**(Rust 체크포인트까지),
 *   아니면 얕은 취소(JS 프라미스만 거부, Rust 핸들러는 끝까지 실행)로
 *   폴백한다. 폴백(동기 엔진) 경로는 기존 T1 배선을 따른다.
 *
 * @example
 * ```ts
 * import { createAsyncEngine } from '@rustra/react-native';
 * const engine = createAsyncEngine(getRustraNative(), { rkyvV2Codecs: registry });
 * const result = await engine.invoke('heavyCompute', { n: 1_000_000 });
 * // 취소 (T1):
 * const ac = new AbortController();
 * engine.invoke('heavyCompute', { n: 1 }, { signal: ac.signal });
 * ac.abort();
 * ```
 */
export function createAsyncEngine(
  native: RustraJSIAsyncNative,
  options: FastEngineOptions,
): EngineClientType {
  const syncEngine = createFastEngine(native, options);

  if (typeof native.invokeTypedAsync !== 'function') {
    // 폴백: 동기 엔진 재사용 (Promise 는 sync 엔진이 이미 반환).
    // 동기 엔진(T1) 이 signal 옵션을 이미 처리하므로 여기서 추가 작업 없음.
    return syncEngine;
  }

  const invokeTypedAsync = native.invokeTypedAsync.bind(native);

  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      const signal = invokeOptions?.signal;
      if (signal?.aborted) {
        // 사전 중단 — 네이티브를 호출하지 않고 즉시 거부한다.
        return Promise.reject(
          new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
        );
      }
      if (!signal) {
        return new Promise<T>((resolve, reject) => {
          invokeTypedAsync(
            command,
            args,
            (result) => resolve(result as T),
            (message) => reject(parseRustraErrorString(message)),
          );
        });
      }
      // 전파 가능 (follow-up 3): 네이티브가 invokeCancel 을 노출하면
      // invokeTypedAsync 가 반환한 invocation id 로 Rust 취소 체크포인트까지
      // 취소가 닿는다. 구형 네이티브(void 반환 또는 invokeCancel 미노출)는
      // 얕은 취소(JS 프라미스만 거부)로 폴백한다.
      if (typeof native.invokeCancel === 'function') {
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          let invocationId = -1;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            if (invocationId >= 0) native.invokeCancel!(invocationId);
            reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
          };
          // invokeTypedAsync 가 콜백을 동기적으로 부를 수 있으므로 리스너를
          // 먼저 단다 — core 전파 경로와 동일한 정리 패턴.
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            const id = invokeTypedAsync(
              command,
              args,
              (result) => {
                if (settled) return; // 늦은 콜백 무시
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(result as T);
              },
              (message) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                reject(parseRustraErrorString(message));
              },
            );
            if (typeof id === 'number') invocationId = id;
          } catch (err) {
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(
              err instanceof Error
                ? err
                : new RustraCommandError(
                    'invoke.failed',
                    `invoke("${command}") dispatch failed: ${String(err)}`,
                  ),
            );
          }
        });
      }
      // 얕은 취소 폴백 — 네이티브에 취소 핸들이 없다. Rust 핸들러는 끝까지
      // 실행되고 늦은 콜백은 무시된다.
      return raceAbortShallow(
        new Promise<T>((resolve, reject) => {
          invokeTypedAsync(
            command,
            args,
            (result) => resolve(result as T),
            (message) => reject(parseRustraErrorString(message)),
          );
        }),
        signal,
        command,
      );
    },
  };

  return {
    invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      return invokeWithTimeout(transport, command, args, invokeOptions);
    },
  };
}

// ── Event push: subscribeEvent (Rust → JS) ───────────────────

/**
 * 이벤트 푸시에 필요한 최소 네이티브 표면 — 구조적 타이핑으로 어떤 호스트
 * 객체도(`RustraNative`, `RustraJSINative`, 테스트 mock) 전달 가능하다.
 */
export type RustraEventNative = {
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
};

/**
 * Rust `emit` → JS 콜백 구독. 반환 함수로 구독 해제한다.
 *
 * 네이티브 경로(C++ JSI `onEvent`/`offEvent`) 위에서:
 * - **페이로드 파싱**: C++ 가 JSON 문자열을 JSI 로 그대로 넘기고(경계 횡단
 *   비용 최소화) 이 래퍼가 `JSON.parse` 1회로 객체를 복원한다. 콜백은 항상
 *   파싱된 객체를 받는다.
 * - **스레딩**: Rust `emit` 은 어느 스레드에서든 호출될 수 있다. C++ 이
 *   이벤트를 큐에 적재하고 JS CallInvoker 로 JS 런타임 스레드에 drain 을
 *   예약하므로 콜백은 항상 JS 스레드에서 실행된다.
 * - **전달 계약**: 첫 구독 시 네이티브가 FFI 이벤트 싱크를 설치한다(폴링
 *   경로 → 푸시 전환). 마지막 구독 해제 시 싱크가 해제되어 폴링 경로로
 *   복귀한다. JS 콜백이 throw 해도 나머지 이벤트는 유실되지 않는다.
 *
 * 네이티브가 `onEvent` 를 노출하지 않으면 기본적으로 `event.unavailable`을
 * 던진다. 조용한 이벤트 유실이 필요한 레거시 앱만 `allowMissingNative: true`를
 * 명시해 no-op 폴백을 선택할 수 있다.
 *
 * @example
 * ```ts
 * import { subscribeEvent } from '@rustra/react-native';
 *
 * const unsubscribe = subscribeEvent(
 *   getRustraNative(), // onEvent/offEvent 를 노출하는 네이티브 객체
 *   'progress.tick',
 *   (payload) => {
 *     console.log(payload.step, '/', payload.total); // 파싱된 객체
 *   },
 * );
 * // 나중에
 * unsubscribe();
 * ```
 */
const nativeListeners = new WeakMap<
  RustraEventNative,
  Map<string, Set<(payload: unknown) => void>>
>();

export function subscribeEvent(
  native: RustraEventNative,
  name: string,
  cb: (payload: unknown) => void,
  options: { allowMissingNative?: boolean } = {},
): () => void {
  if (typeof native.onEvent !== 'function') {
    if (options.allowMissingNative) return () => {};
    throw new RustraCommandError(
      'event.unavailable',
      'native module does not expose onEvent(); event subscription is unavailable',
    );
  }

  let eventMap = nativeListeners.get(native);
  if (!eventMap) {
    eventMap = new Map();
    nativeListeners.set(native, eventMap);
  }

  let listeners = eventMap.get(name);
  if (!listeners) {
    listeners = new Set();
    eventMap.set(name, listeners);

    native.onEvent(name, (payloadJson) => {
      let payload: unknown = null;
      if (payloadJson && payloadJson.length > 0) {
        try {
          payload = JSON.parse(payloadJson);
        } catch {
          payload = null;
        }
      }
      const current = eventMap?.get(name);
      if (current) {
        for (const listener of current) {
          try {
            listener(payload);
          } catch (err) {
            console.error(`Rustra: event listener for "${name}" threw:`, err);
          }
        }
      }
    });
  }

  listeners.add(cb);

  return () => {
    const current = eventMap?.get(name);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      eventMap?.delete(name);
      if (typeof native.offEvent === 'function') {
        native.offEvent(name);
      }
    }
  };
}
