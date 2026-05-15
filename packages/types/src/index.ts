/**
 * @rustra/types — rustra 브릿지의 핵심 타입 및 글로벌 invoke
 *
 * 모든 플랫폼 어댑터(Node, Bun, Tauri, React Native)가 공유하는
 * EngineClient 인터페이스, 에러 타입, rkyv V2 코덱,
 * 그리고 Tauri-like 글로벌 invoke를 제공합니다.
 *
 * @example
 * ```ts
 * // 설정 (플랫폼별, 한 번만)
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/react-native';
 * configure(createRkyvV2Engine(native, registry));
 *
 * // 사용 (어디서든, 타입 안전)
 * import { addNumbers } from './generated/commands.js';
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

// ── Core types ──────────────────────────────────────────────

export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type RustraError = {
  readonly code: string;
  readonly message: string;
};

export class RustraCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RustraCommandError';
    this.code = code;
  }
}

// ── rkyv V2 codec types ────────────────────────────────────

/**
 * rkyv V2 코덱 — 각 명령의 바이너리 인코딩/디코딩을 담당합니다.
 * 코드젠이 명령별로 자동 생성합니다.
 */
export type RkyvV2Codec<I, O> = {
  commandId: number;
  encode(args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: string };
};

/**
 * rkyv V2 네이티브 인터페이스 — 플랫폼별 FFI 브릿지가 구현합니다.
 */
export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

/**
 * 통합 네이티브 인터페이스 — JSI/FFI 브릿지가 노출하는 모든 메서드.
 * 각 어댑터는 필요한 메서드만 사용합니다.
 */
export type RustraNative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  invokeMsgpack(payload: ArrayBuffer): ArrayBuffer;
  invokeBincode(payload: ArrayBuffer): ArrayBuffer;
  invokePostcard(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyv(payload: ArrayBuffer): ArrayBuffer;
  invokeHybrid(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  invokeRaw(payload: ArrayBuffer): ArrayBuffer;
  noop(payload: ArrayBuffer): ArrayBuffer;
};

// ── Global invoke (Tauri-like) ──────────────────────────────

let _engine: EngineClient | null = null;

/**
 * 글로벌 엔진을 설정합니다. 앱 시작 시 한 번만 호출합니다.
 *
 * @param engine - 플랫폼별로 생성한 EngineClient
 *
 * @example
 * ```ts
 * // React Native
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/react-native';
 * configure(createRkyvV2Engine(native, rkyvV2Registry));
 *
 * // Node
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/node';
 * configure(createRkyvV2Engine(nativeAddon, rkyvV2Registry));
 *
 * // Bun
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/bun';
 * configure(createRkyvV2Engine(ffi, rkyvV2Registry));
 * ```
 */
export function configure(engine: EngineClient): void {
  _engine = engine;
}

/**
 * 글로벌 엔진으로 명령을 호출합니다.
 *
 * 일반적으로 직접 호출하지 않고, 코드젠이 생성한 명령 함수를 사용합니다.
 *
 * @example
 * ```ts
 * const result = await invoke<AddNumbersOutput>('addNumbers', { a: 42, b: 58 });
 * // 또는:
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */
export function invoke<T>(command: string, args?: unknown): Promise<T> {
  if (!_engine) {
    throw new Error('Rustra not configured. Call configure(engine) first.');
  }
  return _engine.invoke<T>(command, args);
}

// ── Shared engine factory ──────────────────────────────────

/**
 * rkyv V2 네이티브 모듈로 EngineClient을 생성합니다.
 *
 * 플랫폼 공통 로직 — 코덱 레지스트리로 명령을 인코딩하고
 * 네이티브 FFI로 전송한 뒤 응답을 디코딩합니다.
 */
export function createRkyvV2Engine(
  native: RkyvV2Native,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`RkyvV2: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokeRkyvV2(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error ?? 'RkyvV2 invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}
