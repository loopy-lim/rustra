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
  /**
   * 여러 명령을 한 번에 호출한다 (P0-2). 정적 명령만 있으면 단일 JSI/FFI 횡단
   * (invokeTypedBatch)로 처리하고, 동적 명령이 섞이면 항목별 invoke 로 폴백한다.
   */
  invokeBatch?<T>(entries: BatchEntry[]): Promise<T[]>;
};

/** invokeBatch 의 입력 항목. */
export type BatchEntry = { command: string; args?: unknown };

/**
 * createRkyvV2Engine 이 반환하는 구체 엔진. EngineClient 에 더해 invokeBatch(P0-2) 를
 * 항상 지원한다 — 정적 전용이면 단일 횡단, 동적 혼합이면 항목별 라우팅.
 */
export type RkyvV2Engine = EngineClient & {
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
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
  /** Live schema query (정적 + 동적 명령). JSI/FFI 가 노출하면 사용. */
  getSchema?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 C++ postcard fast path. JSI 가 노출하면 사용. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
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

/**
 * 글로벌 엔진으로 여러 명령을 한 번에 호출합니다 (P0-2 invokeBatch).
 *
 * 정적 명령만 있으면 단일 네이티브 횡단으로 일괄 처리되어 잦은 호출의 jank 를 줄이고,
 * 동적 명령이 섞이면 항목별로 자동 라우팅됩니다.
 *
 * @example
 * ```ts
 * const [a, b] = await invokeBatch([
 *   { command: 'addNumbers', args: { a: 1, b: 2 } },
 *   { command: 'multiply', args: { a: 3, b: 4 } },
 * ]);
 * ```
 */
export function invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
  if (!_engine) {
    throw new Error('Rustra not configured. Call configure(engine) first.');
  }
  if (!_engine.invokeBatch) {
    throw new Error('Configured engine does not support invokeBatch.');
  }
  return _engine.invokeBatch<T>(entries);
}

// ── Live schema (정적 + 동적 명령 조회) ──────────────────────

export type LiveSchemaEntry = {
  commandId: number;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

/** createRkyvV2Engine 이 요구하는 네이티브 인터페이스 (invokeRkyvV2 + live schema). */
export type RkyvV2SchemaNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  getSchema?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 C++ postcard fast path. 둘 다 있으면 JS 코덱 대신 사용. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
};

/**
 * 네이티브 getSchema() 로부터 현재 명령 스키마를 조회한다 (정적 + 동적 명령 포함).
 * 동적 명령의 commandId/타입을 알아내 rkyvV2 Tier 3 fallback 에 사용된다.
 */
export function getLiveSchema(native: { getSchema?(): ArrayBuffer }): Map<string, LiveSchemaEntry> {
  if (!native.getSchema) {
    return new Map();
  }
  const bytes = native.getSchema();
  const json = new TextDecoder().decode(new Uint8Array(bytes));
  const parsed = JSON.parse(json) as {
    commands?: Array<{
      name: string;
      commandId: number;
      inputSchema?: unknown;
      outputSchema?: unknown;
    }>;
  };
  const map = new Map<string, LiveSchemaEntry>();
  for (const c of parsed.commands ?? []) {
    map.set(c.name, {
      commandId: c.commandId,
      inputSchema: c.inputSchema,
      outputSchema: c.outputSchema,
    });
  }
  return map;
}

// ── Tier 3 (JSON-in-binary) wire helpers ────────────────────
// request:  [command_id: u16 LE @0][json @2]
// success:  [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
// error:    [ok:0 @0][pad to @8][err_len: u16 LE @8][err @10]

function encodeTier3Request(commandId: number, args: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(args ?? {}));
  const buf = new Uint8Array(2 + json.length);
  new DataView(buf.buffer).setUint16(0, commandId, true);
  buf.set(json, 2);
  return buf.buffer;
}

function decodeTier3Response(bytes: ArrayBuffer): {
  ok: boolean;
  result?: unknown;
  error?: string;
} {
  const u = new Uint8Array(bytes);
  if (u[0] === 1) {
    const len = new DataView(bytes).getUint32(4, true);
    const json = new TextDecoder().decode(u.slice(8, 8 + len));
    return { ok: true, result: JSON.parse(json) };
  }
  const errLen = new DataView(bytes).getUint16(8, true);
  const err = new TextDecoder().decode(u.slice(10, 10 + errLen));
  return { ok: false, error: err };
}

// ── Shared engine factory ──────────────────────────────────

/**
 * rkyv V2 네이티브 모듈로 EngineClient을 생성한다.
 *
 * 정적 명령은 codegen codec registry 로 fast-path(postcard). registry 에 없는
 * 동적(런타임 등록) 명령은 live schema 에서 commandId 를 조회해 Tier 3(JSON) 로
 * fallback 한다. 단일 엔진이 정적 + 동적 모두 처리.
 */
export function createRkyvV2Engine(
  native: RkyvV2SchemaNative,
  registry: Map<string, RkyvV2Codec<any, any>>,
): RkyvV2Engine {
  // B1 fast path: 네이티브가 C++ typed 코덱(invokeTyped + hasStaticCodec)을 노출하면
  // 정적 명령을 C++에서 postcard 인코딩/디코딩한다 (JS codec 왕복 ~3.4µs 제거).
  const hasTypedPath = !!(native.invokeTyped && native.hasStaticCodec);
  // P0-2: 단일 횡단 배치가 가능하려면 invokeTypedBatch 도 필요.
  const hasBatchPath = hasTypedPath && !!native.invokeTypedBatch;

  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      // 1순위: C++ fast path (RN JSI). 정적 명령만.
      if (hasTypedPath && native.hasStaticCodec!(command)) {
        return Promise.resolve(native.invokeTyped!(command, args) as T);
      }
      // 2순위: JS codec (Node/Bun/Tauri 또는 typed 누락 시). 정적 명령.
      const codec = registry.get(command);
      if (codec) {
        const resultBytes = native.invokeRkyvV2(codec.encode(args));
        const response = codec.decode(resultBytes);
        if (!response.ok) {
          throw new Error(response.error ?? 'RkyvV2 invoke failed');
        }
        return Promise.resolve(response.result as T);
      }
      // 3순위: 동적 명령 → Tier 3 fallback (live schema 의 commandId 사용)
      const entry = getLiveSchema(native).get(command);
      if (!entry) {
        throw new Error(`RkyvV2: no codec and not in live schema for "${command}"`);
      }
      const resp = decodeTier3Response(
        native.invokeRkyvV2(encodeTier3Request(entry.commandId, args)),
      );
      if (!resp.ok) {
        throw new Error(resp.error ?? 'RkyvV2 (tier3) invoke failed');
      }
      return Promise.resolve(resp.result as T);
    },

    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      // 모든 항목이 정적 코덱이면 단일 JSI 횡단(invokeTypedBatch)으로 일괄 처리.
      if (
        hasBatchPath &&
        entries.length > 0 &&
        entries.every((e) => native.hasStaticCodec!(e.command))
      ) {
        const names = entries.map((e) => e.command);
        const args = entries.map((e) => e.args);
        const results = native.invokeTypedBatch!(names, args) as T[];
        return Promise.resolve(results);
      }
      // 동적 명령이 섞였거나 배치 미지원 → 항목별 라우팅(typed/Tier3 자동 분기).
      return Promise.all(entries.map((e) => this.invoke<T>(e.command, e.args)));
    },
  };
}
