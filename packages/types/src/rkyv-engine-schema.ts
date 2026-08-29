import {
  parseLiveSchemaDocument,
  type LiveSchemaEntry,
  type RkyvV2SchemaNative,
} from './live-schema.js';
import type { RkyvSchemaRuntime } from './rkyv-engine-context.js';

/** u64 LE 8바이트 FFI 세대 응답을 number 로 읽는다 (2^53 미만 세대에서 유효). */
function readGeneration(bytes: ArrayBuffer): number {
  return Number(new DataView(bytes).getBigUint64(0, true));
}

export function createRkyvSchemaRuntime(native: RkyvV2SchemaNative): RkyvSchemaRuntime {
  let liveSchemaCache: Map<string, LiveSchemaEntry> | undefined;
  let cachedGeneration: number | undefined;
  /** FFI 세대 읽기 — 미노출이면 undefined, malformed(8바이트 미만 등)면 swallow. */
  const readCachedGeneration = (): number | undefined => {
    if (!native.getSchemaGeneration) return undefined;
    try {
      return readGeneration(native.getSchemaGeneration());
    } catch {
      // malformed 버퍼는 세대 불명으로 취급한다 — 문서 파싱 자체는 계속 유효.
      return undefined;
    }
  };
  const readLiveSchemaDocument = () => {
    const document = parseLiveSchemaDocument(native);
    liveSchemaCache = document.commands;
    // 문서의 세대 필드가 FFI 값과 어긋나는 구 네이티브 방어 — 게이트 기준은
    // FFI 심볼 하나다. FFI 미노출/malformed 호스트는 cachedGeneration 을
    // undefined 로 둬 게이트가 매 호출 재조회하도록 한다(안전 쪽으로).
    cachedGeneration = readCachedGeneration();
    return document;
  };
  const refreshLiveSchema = (): Map<string, LiveSchemaEntry> => {
    return readLiveSchemaDocument().commands;
  };
  const lookupCachedLiveSchemaEntry = (command: string): LiveSchemaEntry | undefined => {
    const cached = liveSchemaCache?.get(command);
    if (cached) return cached;
    try {
      return refreshLiveSchema().get(command);
    } catch {
      // refresh가 문서 파싱 후 세대 읽기 등 후반부에 실패했을 수 있다 — 이때도
      // 캐시는 갱신돼 있으므로 재확인 한 번 더 한다 (spurious not_found 방지).
      return liveSchemaCache?.get(command);
    }
  };

  // (T0-3) 세대 게이트 — FFI 세대가 캐시 세대와 다르면 스테일 캐시다.
  // getSchemaGeneration 미노출(구 RN JSI, Node stdio) 호스트는 게이트를
  // 건너뛴다(현상 유지). malformed 버퍼는 세대 불명으로 세대 불일치 취급 —
  // readLiveSchemaDocument가 매번 재판정한다. 재조회 실패 시 기존 캐시 유지
  // (다음 호출에서 재게이트) — 기존 lookup 폴백 계약 유지.
  const generationGate = (): void => {
    if (!native.getSchemaGeneration) return;
    const current = readCachedGeneration();
    if (current !== undefined && cachedGeneration !== undefined && current === cachedGeneration) {
      return;
    }
    try {
      readLiveSchemaDocument();
    } catch {
      // 재조회 실패 시 기존 캐시 유지 — 다음 호출에서 재게이트한다.
    }
  };

  return { refreshLiveSchema, readLiveSchemaDocument, lookupCachedLiveSchemaEntry, generationGate };
}
