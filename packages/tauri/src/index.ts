/**
 * @rustra/tauri — Tauri 2용 rustra 엔진 어댑터
 *
 * Tauri 애플리케이션에서 rustra 명령을 실행할 수 있는 EngineClient 구현체를 제공합니다.
 * Rust 측의 `rustra_dispatch` Tauri 커맨드를 통해 모든 rustra 명령을 라우팅합니다.
 *
 * ## 설정
 *
 * Rust 측에서 `tauri` feature를 활성화하고 `rustra::tauri_support::register`로
 * 패키지를 등록해야 합니다.
 *
 * @example
 * ```ts
 * import { createTauriEngine } from '@rustra/tauri';
 * import { addNumbers } from './generated/commands.js';
 *
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 *
 * const result = await addNumbers(engine, { a: 20, b: 22 }); // { value: 42 }
 * ```
 */

export type {
  EngineClient,
  EngineSupports,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  InvokeOptions,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  ensureConfigured,
  invoke,
  createRkyvV2Engine,
} from '@rustra/types';

import {
  configureLazy,
  createJsonEngine,
  disposedBootstrapError,
  ensureConfigured,
  normalizeRustraError,
  RustraErrorCode,
  RustraCommandError,
  type BootstrapState,
  type EngineClientWithBatch,
  type EngineSupports,
} from '@rustra/types';

/**
 * Tauri의 IPC invoke 함수 타입입니다.
 *
 * `window.__TAURI__.core.invoke`를 직접 전달하면 됩니다.
 *
 * @example
 * ```ts
 * const invoke: TauriInvoke = window.__TAURI__.core.invoke;
 * ```
 */
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

/**
 * Tauri `event.listen` 함수 시그니처.
 *
 * handler 의 `payload` 는 `unknown` 이다(R03): 실제 WebView 경계(tauri 가
 * `emit_str` JSON 을 `payload: {}` 로 인라인 평가)에선 이미 해석된 값이 오고,
 * 레거시 주입 transport 는 직렬화된 문자열을 줄 수 있다. `subscribeEvent` 가
 * 양쪽을 단일 규칙(문자열만 1회 parse)으로 정규화하므로 이 타입을 문자열로
 * 좁히지 않는다.
 */
export type TauriListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

type TauriGlobal = {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    event?: { listen?: TauriListen };
  };
};

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

function requireTauriInvoke(): TauriInvoke {
  const core = tauriGlobal().__TAURI__?.core;
  if (typeof core?.invoke !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri IPC was not found. Enable app.withGlobalTauri, or pass { invoke } to createTauriEngine().',
    );
  }
  return core.invoke.bind(core);
}

export type TauriEngineOptions = {
  /** Omit when Tauri `app.withGlobalTauri` is enabled. */
  invoke?: TauriInvoke;
};

/**
 * Tauri JSON 엔진의 기술적 지표(A02) — compatibility-matrix.md 의 Tauri 열 셀을
 * 그대로 옮긴 것: in-flight 취소는 얕은 취소, 배치는 per-entry 폴백(와이어
 * 배치는 E2 트랙의 단일 IPC 횡단 최적화 — 셀 표기 계열은 per-entry), 이벤트는
 * Rust `app.emit` 푸시, 채널 어댑터 없음, timeoutMs 레이스 있음.
 */
export const TAURI_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'shallow',
  batch: 'per-entry',
  events: 'push',
  channels: false,
  timeoutPreemption: true,
};

/**
 * Tauri IPC로 EngineClient를 생성합니다.
 *
 * 내부적으로 모든 rustra 명령을 `rustra_dispatch` Tauri 커맨드로 라우팅합니다.
 * `{ command, args }` 형태로 래핑하여 전송합니다.
 *
 * @param options.invoke - Tauri IPC invoke 함수
 * @returns EngineClient 인터페이스를 충족하는 엔진
 *
 * @example
 * ```ts
 * const engine = createTauriEngine({
 *   invoke: window.__TAURI__.core.invoke,
 * });
 * ```
 */
export function createTauriEngine(options: TauriEngineOptions = {}) {
  const tauriInvoke = options.invoke ?? requireTauriInvoke();
  return createJsonEngine(
    {
      invoke: (command, args) => tauriInvoke('rustra_dispatch', { command, args }),
      // 트랙 E2 — N 개 명령을 `rustra_dispatch_batch` 한 번의 IPC 횡단으로
      // 실행한다. Rust 측은 항목별 ok/error 로 응답하므로(fail-fast 아님)
      // 실패 항목만 RustraCommandError 로 재구성해 reject 한다.
      invokeBatch: async (entries) => {
        const responses = (await tauriInvoke('rustra_dispatch_batch', {
          requests: entries.map((entry) => ({ command: entry.command, args: entry.args ?? {} })),
        })) as Array<{ ok: boolean; result?: unknown; error?: unknown }>;
        return Promise.all(
          responses.map(async (response, index) => {
            if (response.ok) return response.result;
            throw normalizeRustraError(
              response.error ?? {
                code: 'invoke.failed',
                message: `batch entry ${entries[index]?.command ?? index} failed without an error payload`,
              },
            );
          }),
        );
      },
    },
    (args) => args ?? {},
    { ...TAURI_ENGINE_SUPPORTS },
  );
}

export type TauriBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 공용 `BootstrapState`(@rustra/types).
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: BootstrapState;
  /** Resolves after the lazily discovered Tauri engine is ready. */
  ready(): Promise<EngineClientWithBatch>;
  /** (A05) dispose-once — 두 번째 호출은 no-op. */
  dispose(): void;
};

/**
 * Registers lazy global-Tauri setup for generated platform entrypoints.
 *
 * 핫스왑 계약(Task A1) — Tauri 어댑터는 reload 표면이 없다. 엔진은 Tauri IPC
 * (rustra_dispatch) 위의 상태 없는 래퍼라 재초기화할 엔진 상태가 없고, 러스트
 * 측 바이너리 교체는 Tauri 호스트 프로세스의 책임이다(재빌드 후 앱 재시작 또는
 * A2 rustra_ffi_hot_reload 주입). dev 루프의 onReload 훅을 Tauri 호스트가 받으면
 * 앱 재시작 안내를 노출하는 것이 정직한 동작이다.
 */
export function createTauriBootstrap(options: TauriEngineOptions = {}): TauriBootstrap {
  let state: 'initializing' | 'ready' | 'disposed' = 'initializing';
  const bootstrap = () => createTauriEngine(options);
  configureLazy(bootstrap);
  const dispose = () => {
    if (state === 'disposed') return; // dispose-once 멱등 — 두 번째는 no-op
    state = 'disposed';
  };
  return {
    get state() {
      return state;
    },
    ready: () => {
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Tauri'));
      return (ensureConfigured() as Promise<EngineClientWithBatch>).then((engine) => {
        if (state === 'disposed') throw disposedBootstrapError('Tauri');
        state = 'ready';
        return engine;
      });
    },
    dispose,
  };
}

export { rustraEventChannel, subscribeEvent, subscribeTauriEvent } from './tauri-events.js';
export { disposedBootstrapError, type BootstrapState } from '@rustra/types';
