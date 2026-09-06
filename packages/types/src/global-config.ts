import { RustraCommandError, RustraErrorCode } from './errors.js';
import { invokeByIdWithTimeout, invokeWithTimeout } from './cancel.js';
import type { EngineClient, InvokeOptions } from './public.js';
import {
  invokeByIdSync,
  resetConfiguredRoutes,
  runtime,
  type InternalEngineClient,
} from './global-state.js';

/** configure/configureLazy 의 선택적 등록자 식별 — 충돌 진단 메시지에만 쓰인다. */
export type ConfigureOptions = {
  /** 등록 주체(호스트/어댑터) 식별자 — 경쟁 등록 거부 시 양쪽 주체를 보고한다. */
  ownerId?: string;
};

/**
 * 글로벌 엔진 슬롯은 단일 엔진 전용이다(R08). 소비되지 않은 pending lazy
 * 등록이 이미 있을 때 다른 initializer 의 등록은 `registry.frozen` 으로
 * 거부한다 — 과거에는 마지막 등록이 조용히 이겼고(import 순서가 엔진을
 * 정하는 교차 라우팅), 소비되기 전까지 아무 신호도 없었다.
 */
function rejectConflictingRegistration(
  initializer: () => EngineClient | Promise<EngineClient>,
  options?: ConfigureOptions,
): void {
  const pendingFresh =
    runtime.engine === null &&
    runtime.engineInitializer !== undefined &&
    runtime.engineInitializer !== initializer && // 같은 클로저 재등록(reload)은 허용
    !runtime.engineInitializerConsumed; // 소비가 시작된 뒤의 교체는 기존 계약 유지
  if (!pendingFresh) return;
  const holder = runtime.engineOwnerId ?? 'an anonymous bootstrap';
  const incoming = options?.ownerId ?? 'an anonymous registration';
  throw new RustraCommandError(
    RustraErrorCode.RegistryFrozen,
    `bootstrap slot already claimed by ${holder} (lazy initialization pending); ` +
      `rejecting conflicting registration from ${incoming}. The engine slot is ` +
      `single-engine: reuse the existing one (reload), or configure() an explicit ` +
      `engine to take over the slot. Multi-engine is not supported.`,
  );
}

export function configure(engine: EngineClient, options?: ConfigureOptions): void {
  runtime.engine = engine;
  runtime.engineInitializer = undefined;
  runtime.engineInitialization = undefined;
  runtime.engineInitializerConsumed = false;
  runtime.engineOwnerId = options?.ownerId;
  resetConfiguredRoutes();
}

export function configureLazy(
  initializer: () => EngineClient | Promise<EngineClient>,
  options?: ConfigureOptions,
): void {
  rejectConflictingRegistration(initializer, options);
  runtime.engine = null;
  runtime.engineInitializer = initializer;
  runtime.engineInitialization = undefined;
  runtime.engineInitializerConsumed = false;
  runtime.engineOwnerId = options?.ownerId;
  resetConfiguredRoutes();
}

export function isLazyConfigured(): boolean {
  return runtime.engineInitializer !== undefined;
}

export function ensureConfigured(): Promise<EngineClient> {
  if (runtime.engine) return Promise.resolve(runtime.engine);
  if (!runtime.engineInitializer)
    return Promise.reject(
      new RustraCommandError(
        RustraErrorCode.TransportUnavailable,
        'Rustra not configured. Call configure(engine), or import the generated React Native entry that registers lazy setup.',
      ),
    );
  if (!runtime.engineInitialization) {
    const initializer = runtime.engineInitializer;
    const generation = runtime.engineGeneration;
    runtime.engineInitializerConsumed = true; // 소비 시작 — 이후 교체는 기존 계약(newer wins) 따름
    const initialization = Promise.resolve()
      .then(initializer)
      .then((engine) => {
        if (runtime.engineGeneration !== generation || runtime.engineInitializer !== initializer)
          return runtime.engine ?? ensureConfigured();
        configure(engine);
        return engine as InternalEngineClient;
      })
      .catch((error) => {
        if (runtime.engineInitialization === initialization)
          runtime.engineInitialization = undefined;
        throw error;
      });
    runtime.engineInitialization = initialization;
  }
  return runtime.engineInitialization;
}

export function resolveCommandId(commandFn: (...args: never[]) => unknown): string {
  const withId = commandFn as { commandId?: unknown };
  if (typeof withId.commandId === 'string' && withId.commandId.length > 0) return withId.commandId;
  if (typeof commandFn.name === 'string' && commandFn.name.length > 0) return commandFn.name;
  throw new Error(
    'Command function must have a commandId or name property (use generated commands or pass a named function)',
  );
}

export function invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured()) return ensureConfigured().then(() => invoke<T>(command, args, options));
    return Promise.reject(
      new RustraCommandError(
        RustraErrorCode.TransportUnavailable,
        'Rustra not configured. Call configure(engine) first.',
      ),
    );
  }
  return invokeWithTimeout(engine, command, args, options);
}

/** @internal — codegen import contract; see note atop global-fields.ts. */
export function invokeGenerated<T>(
  commandId: number,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured())
      return ensureConfigured().then(() => invokeGenerated<T>(commandId, command, args, options));
    return Promise.reject(
      new RustraCommandError(
        RustraErrorCode.TransportUnavailable,
        'Rustra not configured. Call configure(engine) first.',
      ),
    );
  }
  const syncInvoke = engine[invokeByIdSync];
  if (options === undefined && syncInvoke) {
    try {
      return Promise.resolve(syncInvoke<T>(commandId, command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  if (!engine.invokeById) return invokeWithTimeout(engine, command, args, options);
  return invokeByIdWithTimeout(engine, commandId, command, args, options);
}
