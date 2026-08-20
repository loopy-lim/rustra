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
  invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T>;
  /**
   * 여러 명령을 한 번에 호출한다 (P0-2). 정적 명령만 있으면 단일 JSI/FFI 횡단
   * (invokeTypedBatch)로 처리하고, 동적 명령이 섞이면 항목별 invoke 로 폴백한다.
   */
  invokeBatch?<T>(entries: BatchEntry[]): Promise<T[]>;
};

/** invokeBatch 의 입력 항목. `options.signal` 은 항목 단위 취소로 전달된다. */
export type BatchEntry = { command: string; args?: unknown; options?: InvokeOptions };

/**
 * invoke 추가 옵션 (T1).
 *
 * `signal` 이 abort 되면 프라미스를 즉시 reject 한다. 네이티브가
 * `invokeAsync`/`invokeCancel` 을 노출하면 취소를 전파(전파는 JS 코덱
 * 경로만; typed/tier3 경로는 얕은 취소)하고, 그렇지 않으면 JS 프라미스만
 * 거부하는 얕은 취소로 폴백한다 — Rust 핸들러는 끝까지 실행된다.
 */
export type InvokeOptions = {
  /** (T1) AbortSignal — abort 시 Promise 를 즉시 reject 하고, 네이티브가
   *  invokeAsync/invokeCancel 을 노출하면 취소를 전파한다. */
  signal?: AbortSignal;
};

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
  /** Rust `RustraError::retryable` — `transport.error`/`transport.timeout` 등에서 true */
  readonly retryable?: boolean;
};

export class RustraCommandError extends Error {
  readonly code: string;
  /** 재시도 가능한 에러인지 — Rust `RustraError::is_retryable` 와이어 값을 그대로 노출 */
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'RustraCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Rust `RustraError::Display` 포맷(`"{code}: {message}"`)의 평탄화된 문자열을
 * [`RustraCommandError`]로 파싱한다. JSON fallback 경로(네이티브 모듈)에서 사용 —
 * rkyv V2 경로(Node/Tauri)는 구조화된 `{code, message}` 객체를 받으므로 불필요.
 *
 * `": "` 앞이 dot-notation 코드 토큰(`command.not_found`, `internal`,
 * `math.divide_by_zero` 등 — 소문자/숫자/`.`/`_` 만)이면 code/message 를 분리하고,
 * 그렇지 않으면(FFI 수준 에러: `"json decode failed: ..."`, `"payload exceeds size limit"`
 * 등) `invoke.failed` 코드에 전체 문자열을 message 로 쓴다.
 */
export function parseRustraErrorString(error: string | undefined | null): RustraCommandError {
  const raw = error ?? 'Rustra invoke failed';
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; retryable?: unknown };
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        const retryable =
          typeof parsed.retryable === 'boolean' ? parsed.retryable : isRetryableCode(parsed.code);
        return new RustraCommandError(parsed.code, parsed.message, retryable);
      }
    } catch {
      // Fall through to plain text splitting
    }
  }
  const idx = raw.indexOf(': ');
  if (idx > 0) {
    const code = raw.slice(0, idx);
    if (/^[a-z][a-z0-9_.]*$/.test(code)) {
      return new RustraCommandError(code, raw.slice(idx + 2), isRetryableCode(code));
    }
  }
  return new RustraCommandError('invoke.failed', raw);
}

/**
 * 코드 기반 retryable 추론 — Rust `RustraError` 팩토리 관례와 정합.
 * `transport.error`/`transport.timeout`은 Rust 생성 시점에 `retryable: true`로
 * 설정되는 코드군이며 (구조화 와이어에는 retryable 플래그가 없으므로 코드에서
 * 도출한다), `cancelled`도 Rust `RustraError::cancelled` 의 retryable:true 를
 * 미러링한다 (T1 — JSON fallback 경로의 취소 에러 정합).
 */
function isRetryableCode(code: string): boolean {
  return code === 'transport.error' || code === 'transport.timeout' || code === 'cancelled';
}

// ── rkyv V2 codec types ────────────────────────────────────

/**
 * rkyv V2 코덱 — 각 명령의 바이너리 인코딩/디코딩을 담당합니다.
 * 코드젠이 명령별로 자동 생성합니다.
 */
export type RkyvV2Codec<I, O> = {
  commandId: number;
  encode(args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: RustraError };
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
  /**
   * (P0-3) cmd_id 진입 typed fast path — `invokeTyped` 의 u16 디스패치 변형.
   * 문자열 마샬링과 C++ 이름 비교체인을 제거한다 (JSI 횡단 2→1, 문자열 2→0).
   * 미노출 구 네이티브는 이름 기반 `invokeTyped` 로 폴백한다.
   */
  invokeTypedById?(cmdId: number, args: unknown): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
  /**
   * P0-2 byId 변형 — `invokeTypedBatch` 의 cmd_id 배열 진입. 배치 경로에서도
   * 문자열 마샬링 N 회를 제거한다. 미노출 구 네이티브는 이름 기반
   * `invokeTypedBatch` 로 폴백한다.
   */
  invokeTypedBatchById?(cmdIds: number[], args: unknown[]): unknown[];
  /**
   * Rust → JS 이벤트 푸시 리스너 등록(RN JSI). `payloadJson` 은 **JSON 문자열**로
   * 전달된다 — TS 래퍼(`@rustra/react-native` `subscribeEvent`)가
   * `JSON.parse` 1회로 객체로 복원한다. 등록 시점에 C++ 이 FFI 싱크를
   * 설치하고, 이후 Rust `emit` 은 CallInvoker 로 JS 스레드에 마샬링되어
   * 콜백을 호출한다.
   */
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  /** 등록된 이벤트 리스너 제거(RN JSI). 마지막 리스너 제거 시 폴링 경로 복귀. */
  offEvent?(name: string): void;
  /**
   * CallInvoker 없는 호스트의 JS 폴링 drain(RN JSI). 처리된 이벤트 수 반환.
   * CallInvoker 경로가 켜져 있으면 대개 호출 즉시 0(자동 drain 됨).
   */
  drainEvents?(): number;
  /** (T1) 진행 중 async 호출 취소 — invokeAsync 가 반환한 invocation id 를 넘긴다. */
  invokeCancel?(invocationId: number): boolean;
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
 * `options.signal` (T1) 이 abort 되면 엔진의 취소 정책(전파 가능하면
 * 네이티브 전파, 아니면 얕은 취소)에 따라 프라미스가 즉시 reject 됩니다.
 *
 * @example
 * ```ts
 * const result = await invoke<AddNumbersOutput>('addNumbers', { a: 42, b: 58 });
 * // 또는:
 * const result = await addNumbers({ a: 42, b: 58 });
 * // 취소 가능한 호출 (T1):
 * const ac = new AbortController();
 * const r = await invoke('addNumbers', { a: 42, b: 58 }, { signal: ac.signal });
 * ```
 */
export function invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  if (!_engine) {
    throw new Error('Rustra not configured. Call configure(engine) first.');
  }
  // 옵션을 엔진에 그대로 전달한다 (T1). 옵션을 이해하지 못하는 구형/서드파티
  // 엔진은 JS 호출 규약상 추가 인자를 무시한다 — 호출부 파괴 없이 확장된다.
  return _engine.invoke<T>(command, args, options);
}

/**
 * 글로벌 엔진으로 여러 명령을 한 번에 호출합니다 (P0-2 invokeBatch).
 *
 * 정적 명령만 있으면 단일 네이티브 횡단으로 일괄 처리되어 잦은 호출의 jank 를 줄이고,
 * 동적 명령이 섞이면 항목별로 자동 라우팅됩니다.
 *
 * 항목별 취소 (T1 후속): 각 항목의 `options.signal` 이 항목 단위 invoke 로
 * 전달된다 — 해당 항목은 각자 전파(JS 코덱+invokeAsync+invokeCancel 충족 시)
 * 또는 얕은 취소로 동작한다. signal 있는 항목이 하나라도 섞이면 전체가
 * Promise.all 폴백으로 라우팅된다(단일 횡단 경로는 취소를 지원하지 않는다).
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

// ── Runtime-safe UTF-8 helpers ─────────────────────────────
// 임베디드 JS 런타임(예: Hermes)에는 TextEncoder/TextDecoder 글로벌이 없을 수
// 있으므로 엔진은 이에 의존하지 않는다. Pure-JS UTF-8 코덱 (surrogate-pair 정확).
function _utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const low = s.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function _utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const adj = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
      i += 4;
    } else {
      i += 1;
    }
  }
  return s;
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
  /**
   * 네이티브 빌드의 계약 해시(SHA-256 hex)를 반환한다 (F5 opt-in 검증용).
   * `rustra_ffi_contract_hash` 와 대응. `contractHash` 엔진 옵션이 설정된
   * 경우에만 호출된다.
   */
  getContractHash?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 C++ postcard fast path. 둘 다 있으면 JS 코덱 대신 사용. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /**
   * (P0-3) cmd_id 진입 typed fast path — `invokeTyped` 의 id 인덱싱 변형.
   * 문자열 마샬링과 C++ 이름 비교체인을 u16 디스패치로 대체한다
   * (JSI 횡단 2→1, 문자열 2→0). 미노출 구 네이티브는 이름 기반
   * `invokeTyped` 로 폴백한다.
   */
  invokeTypedById?(cmdId: number, args: unknown): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
  /**
   * P0-2 byId 변형 — `invokeTypedBatch` 의 cmd_id 배열 진입. 배치 경로에서도
   * 문자열 마샬링 N 회를 제거한다. 미노출 구 네이티브는 이름 기반
   * `invokeTypedBatch` 로 폴백한다.
   */
  invokeTypedBatchById?(cmdIds: number[], args: unknown[]): unknown[];
  /** (T1) 취소 전파 가능한 비동기 invoke — invocation id 를 반환하고, 결과는 콜백으로. */
  invokeAsync?(payload: ArrayBuffer, onDone: (response: ArrayBuffer) => void): number;
  /** (T1) 진행 중 async 호출 취소. */
  invokeCancel?(invocationId: number): boolean;
};

/**
 * getSchema() 원본 JSON 의 파싱 결과 — 명령 맵과 (T2) 최상위 schemaVersion.
 * schemaVersion 은 유한 number 인 경우에만 채운다 (구 네이티브는 필드 자체가
 * 없다 — 없으면 undefined 로 두고 소비자에서 관례값 1 로 취급한다).
 */
type LiveSchemaDocument = {
  commands: Map<string, LiveSchemaEntry>;
  schemaVersion?: number;
};

/** getLiveSchema 의 파싱 내부 — 엔진 생성 시 schemaVersion 까지 읽는다 (T2). */
function parseLiveSchemaDocument(native: { getSchema?(): ArrayBuffer }): LiveSchemaDocument {
  if (!native.getSchema) {
    // (의미론 마감) 네이티브가 getSchema 를 노출하지 않으면 live schema 자체를
    // 얻을 수 없다 — 빈 Map 을 돌려주면 Tier 3 동적 명령이 command.not_found 로
    // 오해받는다. 스키마 조회가 실제로 필요한 호출자가 즉시 실패하도록 명시적
    // 에러를 던진다 (엔진 생성 시 schemaVersion 협상은 선택적이라 try/catch 로
    // 이미 흡수된다).
    throw new RustraCommandError(
      'schema.unavailable',
      'native module does not expose getSchema(); live schema is unavailable',
    );
  }
  const bytes = native.getSchema();
  const u = new Uint8Array(bytes);
  const json = _utf8Decode(u, 0, u.length);
  const parsed = JSON.parse(json) as {
    schemaVersion?: unknown;
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
  const doc: LiveSchemaDocument = { commands: map };
  if (typeof parsed.schemaVersion === 'number' && Number.isFinite(parsed.schemaVersion)) {
    doc.schemaVersion = parsed.schemaVersion;
  }
  return doc;
}

/**
 * 네이티브 getSchema() 로부터 현재 명령 스키마를 조회한다 (정적 + 동적 명령 포함).
 * 동적 명령의 commandId/타입을 알아내 rkyvV2 Tier 3 fallback 에 사용된다.
 * getSchema 미노출 네이티브에서는 schema.unavailable 에러를 던진다.
 */
export function getLiveSchema(native: { getSchema?(): ArrayBuffer }): Map<string, LiveSchemaEntry> {
  return parseLiveSchemaDocument(native).commands;
}

/**
 * live schema 에서 단일 명령 항목을 찾는다 — 스키마 접근이 불가(getSchema 미노출)
 * 이면 undefined 를 반환해 호출자가 자체 폴백(얕은 취소/command.not_found)을
 * 택하도록 한다. 전체 스키마 파싱 실패와 "명령이 정말 없는 경우"를 구분하기
 * 위한 좁은 헬퍼.
 */
function lookupLiveSchemaEntry(
  native: { getSchema?(): ArrayBuffer },
  command: string,
): LiveSchemaEntry | undefined {
  try {
    return getLiveSchema(native).get(command);
  } catch {
    return undefined;
  }
}

// ── Tier 3 (JSON-in-binary) wire helpers ────────────────────
// request:  [command_id: u16 LE @0][json @2]
// success:  [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
// error:    [ok:0 @0][pad to @8][err_len: u16 LE @8][postcard({code,message}) @10]

function encodeTier3Request(commandId: number, args: unknown): ArrayBuffer {
  const json = _utf8Encode(JSON.stringify(args ?? {}, _jsonSetReplacer));
  const buf = new Uint8Array(2 + json.length);
  new DataView(buf.buffer).setUint16(0, commandId, true);
  buf.set(json, 2);
  return buf.buffer;
}

/**
 * JSON 경로에서 `Set`을 배열로 직렬화한다 — Rust `BTreeSet`/`HashSet`은
 * serde JSON 에서 배열로 직렬화되므로 와이어 호환을 맞춘다
 * (`Map`은 rustra 계약에 없으므로 다루지 않는다).
 */
function _jsonSetReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  return value;
}

// postcard varint + length-prefixed string decode, local to the Tier 3 path so
// this file has no dependency on the generated codec helpers.
function _tier3DecodeString(u: Uint8Array, offset: number): { value: string; bytesRead: number } {
  let shift = 0;
  let bytesRead = 0;
  let len = 0;
  while (true) {
    const b = u[offset + bytesRead];
    len |= (b & 0x7f) << shift;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (bytesRead > 5) throw new Error('varint too long');
  }
  len = len >>> 0;
  const start = offset + bytesRead;
  return {
    value: _utf8Decode(u, start, start + len),
    bytesRead: bytesRead + len,
  };
}

function decodeTier3Response(bytes: ArrayBuffer): {
  ok: boolean;
  result?: unknown;
  error?: RustraError;
} {
  if (bytes.byteLength < 8) {
    return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
  }
  const u = new Uint8Array(bytes);
  if (u[0] === 1) {
    const len = new DataView(bytes).getUint32(4, true);
    if (bytes.byteLength < 8 + len) {
      return {
        ok: false,
        error: { code: 'invoke.too_short', message: 'response payload truncated' },
      };
    }
    const json = _utf8Decode(u, 8, 8 + len);
    try {
      return { ok: true, result: JSON.parse(json) };
    } catch (e) {
      return { ok: false, error: { code: 'invoke.malformed', message: `invalid json: ${e}` } };
    }
  }
  if (bytes.byteLength < 10) {
    return { ok: false, error: { code: 'invoke.too_short', message: 'error frame too short' } };
  }
  const errLen = new DataView(bytes).getUint16(8, true);
  let error: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
  if (errLen > 0) {
    // postcard({ code: String, message: String })
    try {
      const { value: code, bytesRead: b1 } = _tier3DecodeString(u, 10);
      const { value: message } = _tier3DecodeString(u, 10 + b1);
      error = { code, message };
    } catch {
      // fallback if postcard decoding fails
    }
  }
  return { ok: false, error };
}

// ── Shared engine factory ──────────────────────────────────

/**
 * rkyv V2 네이티브 모듈로 EngineClient을 생성한다.
 *
 * 정적 명령은 codegen codec registry 로 fast-path(postcard). registry 에 없는
 * 동적(런타임 등록) 명령은 live schema 에서 commandId 를 조회해 Tier 3(JSON) 로
 * fallback 한다. 단일 엔진이 정적 + 동적 모두 처리.
 */
/**
 * `createRkyvV2Engine` 옵션. 모두 opt-in 이며 생략 시 하위 호환 동작을 유지한다.
 */
export type RkyvV2EngineOptions = {
  /**
   * (F5) 빌드 시점 코드젠이 생성한 계약 해시(`GENERATED_CONTRACT_HASH`).
   * 설정하면 엔진 생성 시 네이티브의 실시간 해시(`getContractHash`)와 비교해
   * 불일치면 즉시 throw 한다 — 생성된 클라이언트와 네이티브 바이너리의 스키마
   * 드리프트를 시작 시점에 잡는다. 미설정 시 검증하지 않는다(기본값).
   */
  contractHash?: string;
  /**
   * (T2, OTA) 계약 해시 불일치 시의 정책. 미설정 시 기존대로 throw
   * (fail-fast). 콜백을 설정하면 throw 대신 호출 후 **degraded 모드**로
   * 엔진을 계속 생성한다 — 구 JS + 신 네이티브(또는 그 반대) OTA 조합에서
   * 앱 전체 마비 대신 부분 동작을 택하는 배포 정책에 사용한다.
   * degraded 모드는 위험하다: 호환되지 않는 명령은 codec/tier3 디코딩에서
   * 실패할 수 있다. 콜백에서 live schema 를 조회해 공통 명령만 쓰도록
   * 안내하는 것은 호출자의 책임이다.
   *
   * `getContractHash` 미노출 네이티브는 검증 자체가 불가능하므로 이 콜백과
   * 무관하게 항상 `contract.unenforceable` 로 throw 한다 (native hash 가
   * 없으면 degraded 모드가 무의미하다).
   */
  onContractMismatch?: (info: { nativeHash: string; expectedHash: string }) => void;
  /**
   * (T2, OTA) 빌드 시점 스키마 버전 — 코드젠이 생성한 SCHEMA_VERSION.
   * 설정하면 엔진 생성 시 live schema(getSchema)의 schemaVersion 과 비교해
   * JS > native 면 onSchemaStale 콜백(또는 console.warn)으로 경고한다.
   * 구 JS + 신 네이티브가 정상인 조합(신 기능은 못 쓰지만 기존 동작)과
   * 달리, JS > native 는 "네이티브가 구버전" — OTA 롤백/지연 배포 상황.
   * fatal 아님: 경고만 한다. 미설정 시 검증하지 않는다.
   *
   * 구 네이티브(pre-Task-8)는 schemaVersion 필드 없는 schema JSON 을,
   * 미등록 패키지는 `{}` 를 반환한다 — live schemaVersion 이 없으면 CLI 의
   * old-schema 관례대로 **1 로 취급**한다 (이 기능의 대상인 구 바이너리이며
   * 비교 불가(undefined→NaN) 로 스퓨리어스 경고하지 않게 막는다).
   */
  schemaVersion?: number;
  /** (T2) schemaVersion 검증 결과 JS > native 인 경우의 콜백. 미설정 시 console.warn. */
  onSchemaStale?: (info: { nativeVersion: number; jsVersion: number }) => void;
  /**
   * (T3) 요청 페이로드 바이트 한도. 인코딩 직후 검사해 네이티브 왕복 전에
   * 조기 실패시킨다 — 네이티브 호출을 아끼고 에러에 컨텍스트(인코딩된 크기)
   * 를 싣는다. typed(C++ fast path) 경로는 JS 측 인코딩이 없어 검사를
   * 건너뛴다 — 네이티브 한도가 적용된다. 미설정 시 검사하지 않는다
   * (네이티브의 동적 한도가 최종 게이트). 값은 양의 정수여야 한다 —
   * 0/음수는 모든 페이로드를 거부한다 (전문가 노브, 클램핑 없음).
   */
  maxPayloadBytes?: number;
};

/**
 * tier 2(JS 코덱) 응답 프레임을 결과/에러로 환산한다 — `dispatch` 와 전파
 * 경로 콜백이 공유하는 유일 경로 (T1 리뷰). `codec.decode` 가 잘못된 프레임으로
 * throw 하면 그 예외를 reject 값으로 돌린다(비-Error 는 `invoke.failed` 로
 * 래핑): 전파 경로의 콜백은 네이티브 트램펄린 안에서 실행되므로 예외가
 * 새어나가면 프라미스가 영원히 정착하지 않는다. 이 함수 자체는 throw 하지 않는다.
 */
function tier2Outcome<T>(
  codec: RkyvV2Codec<unknown, unknown>,
  frame: ArrayBuffer,
): { ok: true; value: T } | { ok: false; error: Error } {
  let response: ReturnType<RkyvV2Codec<unknown, unknown>['decode']>;
  try {
    response = codec.decode(frame);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err
          : new RustraCommandError('invoke.failed', `codec decode failed: ${String(err)}`),
    };
  }
  if (!response.ok) {
    const e = response.error ?? { code: 'invoke.failed', message: 'RkyvV2 invoke failed' };
    return {
      ok: false,
      error: new RustraCommandError(e.code, e.message, e.retryable ?? isRetryableCode(e.code)),
    };
  }
  return { ok: true, value: response.result as T };
}

/**
 * 얕은 취소 (T1) — 네이티브 전파가 불가능할 때 JS 프라미스만 거부한다.
 * Rust 핸들러는 끝까지 실행되며, 그 결과는 이 프라미스 체인에서 버려진다.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, command: string): Promise<T> {
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
 * (T3) 인코딩된 페이로드의 크기 사전 검사 — JS 코덱(tier 2)/tier 3 경로가
 * 네이티브를 호출하기 직전에 공유한다. `limit` 이 undefined 면 검사하지 않는다
 * (네이티브의 동적 한도가 최종 게이트). 초과 시 `payload.too_large`
 * (non-retryable — 결정론적 클라이언트 조건) 를 반환하고 호출자는 네이티브
 * 왕복 없이 즉시 reject 한다.
 */
function payloadTooLargeError(
  encodedBytes: number,
  limit: number | undefined,
): RustraCommandError | undefined {
  if (limit === undefined || encodedBytes <= limit) return undefined;
  return new RustraCommandError(
    'payload.too_large',
    `encoded payload ${encodedBytes}B exceeds maxPayloadBytes ${limit}B`,
    false,
  );
}

export function createRkyvV2Engine(
  native: RkyvV2SchemaNative,
  registry: Map<string, RkyvV2Codec<unknown, unknown>>,
  options?: RkyvV2EngineOptions,
): RkyvV2Engine {
  // F5 (opt-in): 계약 해시 검증. 빌드 시점 hash 와 네이티브 실시간 hash 가 다르면
  // 기본적으로 엔진을 만들지 않고 즉시 실패(fail-fast)한다. T2 onContractMismatch
  // 콜백을 설정하면 불일치 시 throw 대신 콜백 호출 후 degraded 모드로 계속 생성한다.
  if (options?.contractHash !== undefined) {
    if (typeof native.getContractHash !== 'function') {
      // unenforceable 은 콜백과 무관하게 항상 throw — native hash 가 없으면
      // degraded 모드가 무의미하다 (검증 가능한 것이 아무것도 없다).
      throw new RustraCommandError(
        'contract.unenforceable',
        'contractHash option was set but the native module does not expose ' +
          'getContractHash(); cannot verify schema drift',
      );
    }
    const hashBytes = new Uint8Array(native.getContractHash());
    const nativeHash = _utf8Decode(hashBytes, 0, hashBytes.length).trim();
    if (nativeHash !== options.contractHash) {
      if (!options.onContractMismatch) {
        throw new RustraCommandError(
          'contract.mismatch',
          `contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs ` +
            `expected="${options.contractHash.slice(0, 16)}…" — generated client ` +
            `and native binary are out of sync; regenerate the client`,
        );
      }
      options.onContractMismatch({ nativeHash, expectedHash: options.contractHash });
    }
  }

  // T2 (opt-in): schemaVersion staleness 검사. JS > native 면 경고만 한다
  // (fatal 아님 — OTA 롤백/지연 배포 상황에서도 앱은 동작해야 한다).
  // getSchema 미노출 구 네이티브는 조용히 건너뛴다 (비교할 것이 없다).
  if (options?.schemaVersion !== undefined && typeof native.getSchema === 'function') {
    // 구 네이티브(pre-Task-8)의 schema JSON 에는 schemaVersion 이 없다 —
    // CLI old-schema 관례대로 1 로 취급한다. 이 기능의 대상이 되는 정확히 그
    // 구 바이너리를 향한 스퓨리어스 경고를 막는 디폴트다.
    //
    // 스키마 파싱(getSchema 호출 자체의 실패 포함)은 절대 치명적이지 않다 —
    // 파싱이 throw 하면 staleness 검사를 조용히 건너뛴다 (getSchema 미노출
    // 경우와 동일한 취급). 경고 기능이 엔진 생성을 깨뜨리면 "fatal 아님"
    // 계약 자체가 위반된다. invoke 시점의 tier-3 스키마 파싱(getLiveSchema)은
    // 별개의 기존 동작 — malformed 스키마에서 동적 명령 호출 시 JSON.parse 가
    // dispatch 밖으로 동기 throw 할 수 있다.
    let nativeVersion: number | undefined;
    try {
      nativeVersion = parseLiveSchemaDocument(native).schemaVersion ?? 1;
    } catch {
      nativeVersion = undefined;
    }
    if (nativeVersion !== undefined && options.schemaVersion > nativeVersion) {
      const info = { nativeVersion, jsVersion: options.schemaVersion };
      if (options.onSchemaStale) {
        options.onSchemaStale(info);
      } else {
        console.warn(
          `[rustra] schema stale: JS bundle schemaVersion=${info.jsVersion} > ` +
            `native schemaVersion=${info.nativeVersion} — native binary is older ` +
            `than the JS bundle (OTA rollback / delayed rollout); newer commands ` +
            `may fail until native catches up`,
        );
      }
    }
  }

  // B1 fast path: 네이티브가 C++ typed 코덱(invokeTyped + hasStaticCodec)을 노출하면
  // 정적 명령을 C++에서 postcard 인코딩/디코딩한다 (JS codec 왕복 ~3.4µs 제거).
  const hasTypedPath = !!(native.invokeTyped && native.hasStaticCodec);
  // P0-3: byId 진입(invokeTypedById)이 가능한지 — 가능하면 dispatch 1순위가
  // JSI 1회 횡단 + u16 디스패치로 바뀐다. 미노출이면 이름 기반 invokeTyped 유지.
  const hasByIdPath = hasTypedPath && typeof native.invokeTypedById === 'function';
  // P0-2: 단일 횡단 배치가 가능하려면 invokeTypedBatch 도 필요.
  const hasBatchPath = hasTypedPath && !!native.invokeTypedBatch;
  // P0-2 byId: 배치 진입의 cmd_id 배열 변형 — 문자열 마샬링 N 회 제거.
  const hasBatchByIdPath = hasBatchPath && typeof native.invokeTypedBatchById === 'function';
  // (T3) JS 사전 크기 검사 — undefined 면 검사하지 않는다 (네이티브 동적 한도가
  // 최종 게이트). typed(tier 1) 경로는 JS 측 인코딩이 없어 검사 대상이 아니다.
  const payloadLimit = options?.maxPayloadBytes;

  // 정적 명령 집합 JS 캐시 (P0-3) — hasStaticCodec JSI 호출을 호출당 1회에서
  // 엔진 생애 1회 스윕으로 축소한다. 불변식: 코드젠 시점 정적 명령은 항상
  // registry 에 있다 (registry 도 코드젠 산출물). registry 에 없는 이름은
  // 동적 명령 → Tier 3 경로. 스윕은 registry 를 기준으로 하므로 C++ 코덱만
  // 있고 registry 에 빠진 정적 명령(불변식 위반)도 자연스럽게 Tier 3 로 간다.
  // 스윕 도중 예외 시 부분 맵 재사용 — 미스윕 항목은 registry 안 이름이므로
  // Tier 2(JS codec)로 라우팅된다. Tier 3는 registry 밖 동적 명령 전용 경로다.
  let staticCommandIds: Map<string, number> | null = null;
  const ensureStaticIds = (): Map<string, number> | null => {
    if (staticCommandIds !== null || !hasTypedPath) return staticCommandIds;
    staticCommandIds = new Map();
    for (const [name, codec] of registry) {
      if (native.hasStaticCodec!(name)) staticCommandIds.set(name, codec.commandId);
    }
    return staticCommandIds;
  };

  // 신호 없는 기본 3-티어 dispatch (T1 리팩터링 — 로직은 기존 그대로).
  const dispatch = async <T>(command: string, args?: unknown): Promise<T> => {
    // 1순위: C++ fast path (RN JSI). 정적 명령만. JS 측 인코딩이 없어
    // maxPayloadBytes 검사를 건너뛴다 — 네이티브 한도가 그대로 적용된다.
    // byId 진입이 가능하면 JSI 1회 + u16 디스패치 (P0-3).
    if (hasTypedPath) {
      const cmdId = ensureStaticIds()?.get(command);
      if (cmdId !== undefined) {
        if (hasByIdPath) {
          return native.invokeTypedById!(cmdId, args) as T;
        }
        return native.invokeTyped!(command, args) as T;
      }
    }
    // 2순위: JS codec (Node/Bun/Tauri 또는 typed 누락 시). 정적 명령.
    const codec = registry.get(command);
    if (codec) {
      const encoded = codec.encode(args);
      // (T3) 네이티브 왕복 전에 크기 검사 — 초과면 invokeRkyvV2 를 부르지 않는다.
      const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
      if (tooLarge) throw tooLarge;
      const resultBytes = native.invokeRkyvV2(encoded);
      // Reject (do not throw) so the declared Promise<T> contract holds and
      // callers can use .catch() / await-try-consistently for command errors.
      const outcome = tier2Outcome<T>(codec, resultBytes);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }
    // 3순위: 동적 명령 → Tier 3 fallback (live schema 의 commandId 사용).
    // getSchema 미노출 네이티브에서 lookupLiveSchemaEntry 는 undefined 를
    // 돌려주므로 기존 command.not_found 계약이 그대로 유지된다.
    const entry = lookupLiveSchemaEntry(native, command);
    if (!entry) {
      throw new RustraCommandError(
        'command.not_found',
        `RkyvV2: no codec and not in live schema for "${command}"`,
      );
    }
    const tier3Request = encodeTier3Request(entry.commandId, args);
    // (T3) tier 2 와 동일한 사전 검사 — 네이티브 호출 전에 조기 실패.
    const tooLarge = payloadTooLargeError(tier3Request.byteLength, payloadLimit);
    if (tooLarge) throw tooLarge;
    const resp = decodeTier3Response(native.invokeRkyvV2(tier3Request));
    if (!resp.ok) {
      const e = resp.error ?? { code: 'invoke.failed', message: 'RkyvV2 (tier3) invoke failed' };
      throw new RustraCommandError(e.code, e.message, e.retryable ?? isRetryableCode(e.code));
    }
    return resp.result as T;
  };

  return {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      const signal = options?.signal;
      if (signal?.aborted) {
        return Promise.reject(
          new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
        );
      }
      if (!signal) return dispatch<T>(command, args);
      // 네이티브 전파 경로 (T1): JS 코덱(tier 2) 명령이고 invokeAsync +
      // invokeCancel 이 모두 노출되면 Rust 측 체크포인트까지 취소가 닿는다.
      // typed(tier 1)/tier 3 동적 경로는 invokeAsync 가 있어도 얕은 취소로
      // 폴백한다 (설계 노트: 전파는 JS 코덱 경로만).
      const codec = registry.get(command);
      // P0-3: hasStaticCodec JSI 호출 대신 엔진 생애 1회 스윕 캐시 조회.
      const onTypedPath = hasTypedPath && ensureStaticIds()?.has(command) === true;
      if (!onTypedPath && codec && native.invokeAsync && native.invokeCancel) {
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          let invocationId = -1;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            native.invokeCancel!(invocationId);
            reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
          };
          // encode/invokeAsync 가 동기 throw 해도 abort 리스너가 signal 에
          // 새어남기지 않도록 try/catch 로 정리한다. catch 에서 reject 할 때
          // 이미 콜백이 정착했다면 reject 는 no-op 이므로 안전하다.
          try {
            // invokeAsync 가 콜백을 동기적으로 부를 수 있으므로 리스너를 먼저 단다.
            signal.addEventListener('abort', onAbort, { once: true });
            const encoded = codec.encode(args);
            // (T3) 전파 경로도 동일한 사전 검사 — 초과면 invokeAsync 를 부르지
            // 않고 throw 한다. Error 이므로 아래 catch 가 리스너를 정리한 뒤
            // 그대로 reject 한다 (기존 동기 throw 정리 경로 재사용).
            const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
            if (tooLarge) throw tooLarge;
            invocationId = native.invokeAsync!(encoded, (resp) => {
              if (settled) return;
              // settled 를 올리기 전에 환산한다 — tier2Outcome 은 decode 가
              // throw 해도 (잘못된 프레임) 에러로 환산할 뿐 절대 throw 하지
              // 않으므로, 이 지점 이후 프라미스는 반드시 정착한다. 예외가
              // 네이티브 트램펄린으로 새어나가 영원히 대기하는 일이 없다.
              const outcome = tier2Outcome<T>(codec, resp);
              settled = true;
              signal.removeEventListener('abort', onAbort);
              if (outcome.ok) resolve(outcome.value);
              else reject(outcome.error);
            });
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
      // (의미론 마감) typed(tier 1)/tier 3 경로 전파 확장 — 코덱이 없어도
      // invokeAsync + invokeCancel 이 노출되면 Rust 취소 체크포인트까지 전파한다.
      // 인코딩: typed 캐시에 commandId 가 있으면 Tier 3(JSON-in-binary) 프레임으로
      // invokeRkyvV2 와 동일한 와이어를 invokeAsync 로 보낸다. commandId 를 모르면
      // (live schema 미노출) 얕은 취소로 폴백한다.
      if (!codec && native.invokeAsync && native.invokeCancel) {
        const cmdId = hasTypedPath ? ensureStaticIds()?.get(command) : undefined;
        const entry =
          cmdId !== undefined ? { commandId: cmdId } : lookupLiveSchemaEntry(native, command);
        if (entry) {
          return new Promise<T>((resolve, reject) => {
            let settled = false;
            let invocationId = -1;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              native.invokeCancel!(invocationId);
              reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
            };
            try {
              signal.addEventListener('abort', onAbort, { once: true });
              const encoded = encodeTier3Request(entry.commandId, args);
              const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
              if (tooLarge) throw tooLarge;
              invocationId = native.invokeAsync!(encoded, (resp) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                const outcome = decodeTier3Response(resp);
                if (outcome.ok) resolve(outcome.result as T);
                else {
                  const e =
                    outcome.error ??
                    ({ code: 'invoke.failed', message: 'RkyvV2 (tier3) invoke failed' } as const);
                  reject(new RustraCommandError(e.code, e.message, e.retryable ?? false));
                }
              });
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
      }
      // 전파 불가 — 얕은 취소 (JS 프라미스만 거부, Rust 는 끝까지 실행):
      return raceAbort(dispatch<T>(command, args), signal, command);
    },

    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      // 계약: 단일 JSI 횡단 배치(invokeTypedBatch[ById])는 취소를 지원하지
      // 않는다 — signal 이 붙은 항목이 하나라도 있으면 자동으로 항목별
      // invoke 경로(각자의 전파/얕은 취소 정책)로 라우팅된다. 배치 자체의
      // 항목별 취소 지원은 명시적 미지원 계약 (followup-3 유예 유지).
      //
      // 모든 항목이 정적 코덱이고 signal 이 없어야 단일 JSI 횡단으로 일괄 처리.
      // 단일 횡단 진입은 2단계: byId 배치(invokeTypedBatchById) 가 우선, 미노출이면
      // 이름 기반 invokeTypedBatch(아래 분기 참조). 정적 여부/id 조사는 캐시
      // 조회로 한다 (P0-3: hasStaticCodec JSI 호출 N 회 → 엔진 생애 1회 스윕).
      const staticIds = hasBatchPath && entries.length > 0 ? ensureStaticIds() : null;
      if (
        staticIds &&
        entries.every((e) => staticIds.has(e.command)) &&
        entries.every((e) => !e.options?.signal)
      ) {
        const args = entries.map((e) => e.args);
        // byId 진입(P0-2 후속): 네이티브가 cmd_id 배열 배치를 노출하면 문자열
        // 배열 마샬링 없이 id 로 단일 횡단. 모든 항목의 id 가 캐시에 있는 위의
        // every 검사가 이미 조립 가능성을 보장한다.
        if (hasBatchByIdPath) {
          const ids = entries.map((e) => staticIds.get(e.command)!);
          const results = native.invokeTypedBatchById!(ids, args) as T[];
          return Promise.resolve(results);
        }
        const names = entries.map((e) => e.command);
        const results = native.invokeTypedBatch!(names, args) as T[];
        return Promise.resolve(results);
      }
      // 동적 명령/시그널 항목이 섞였거나 배치 미지원 → 항목별 라우팅.
      // 항목의 options(signal) 를 그대로 실어 보내 항목 단위 취소가 각자의
      // 취소 정책(전파/얕은)을 따르게 한다 (T1 후속).
      return Promise.all(entries.map((e) => this.invoke<T>(e.command, e.args, e.options)));
    },
  };
}
