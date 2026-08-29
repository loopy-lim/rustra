import { RustraCommandError } from './errors.js';
import { decodeUtf8 } from './utf8.js';

// ── Live schema (정적 + 동적 명령 조회) ──────────────────────

export type LiveSchemaEntry = {
  commandId: number;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

/** createRkyvV2Engine 이 요구하는 네이티브 인터페이스 (invokeRkyvV2 + live schema). */
export type RkyvV2SchemaNative = {
  /**
   * 응답은 소유 ArrayBuffer 또는 재사용 버퍼의 뷰(ArrayBufferView)다. 뷰는
   * 이 호출의 디코드가 끝날 때까지만 유효하다(다음 invoke 가 덮어쓴다) —
   * dispatch 는 응답을 동기로 즉시 디코드하므로 안전하다.
   */
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer | ArrayBufferView;
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
  /** bit 0 = typed, bit 1 = positional, bit 2 = raw scalar, bit 3 = byte buffer. */
  getCodecCapabilities?(cmdId: number): number;
  /** Tier 0 scalar entry. Successful results retain the generated public shape. */
  invokeTypedRaw?(cmdId: number, ...fields: unknown[]): unknown;
  /** Tier 1 positional entry for one to three flat generated fields. */
  invokeTypedPos?(cmdId: number, ...fields: unknown[]): unknown;
  /** Synchronous single-`Vec<u8>` entry; input is borrowed only for the call. */
  invokeTypedBuffer?(cmdId: number, value: Uint8Array | ArrayBuffer): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
  /**
   * P0-2 byId 변형 — `invokeTypedBatch` 의 cmd_id 배열 진입. 배치 경로에서도
   * 문자열 마샬링 N 회를 제거한다. 미노출 구 네이티브는 이름 기반
   * `invokeTypedBatch` 로 폴백한다.
   */
  invokeTypedBatchById?(cmdIds: number[], args: unknown[]): unknown[];
  /**
   * (T1) 취소 전파 가능한 비동기 invoke — invocation id 를 반환하고, 결과는 콜백으로.
   *
   * **호스트 구현 계약**: payload 는 `invokeRkyvV2` 와 동일한 rkyv V2 요청
   * 프레임(정적 postcard 또는 Tier 3 JSON-in-binary)이고, 응답도 동일한 응답
   * 프레임을 `onDone` 으로 전달한다. 반환된 invocation id 로 `invokeCancel` 을
   * 호출하면 Rust 측 취소 체크포인트까지 전파된다. 이 모듈(native adapter)을
   * 구현하는 호스트는 워커/비동기 스레드에서 invoke 를 실행하고, 취소 시
   * `cancelled` 에러 프레임을 콜백해야 한다.
   */
  invokeAsync?(payload: ArrayBuffer, onDone: (response: ArrayBuffer) => void): number;
  /** (T1) 진행 중 async 호출 취소 — `invokeAsync` 가 반환한 invocation id 를 넘긴다. */
  invokeCancel?(invocationId: number): boolean;
};

/**
 * getSchema() 원본 JSON 의 파싱 결과 — 명령 맵과 (T2) 최상위 schemaVersion.
 * schemaVersion 은 유한 number 인 경우에만 채운다 (구 네이티브는 필드 자체가
 * 없다 — 없으면 undefined 로 두고 소비자에서 관례값 1 로 취급한다).
 */
export type LiveSchemaDocument = {
  commands: Map<string, LiveSchemaEntry>;
  schemaVersion?: number;
};

/** getLiveSchema 의 파싱 내부 — 엔진 생성 시 schemaVersion 까지 읽는다 (T2). */
export function parseLiveSchemaDocument(native: { getSchema?(): ArrayBuffer }): LiveSchemaDocument {
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
  const json = decodeUtf8(u, 0, u.length);
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
