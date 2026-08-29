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
  const readLiveSchemaDocument = () => {
    const document = parseLiveSchemaDocument(native);
    liveSchemaCache = document.commands;
    // 문서의 세대 필드가 FFI 값과 어긋나는 구 네이티브 방어 — 게이트 기준은
    // FFI 심볼 하나다. FFI 미노출 호스트는 cachedGeneration 을 undefined 로
    // 둬 게이트 자체를 스킵한다.
    cachedGeneration = native.getSchemaGeneration
      ? readGeneration(native.getSchemaGeneration())
      : undefined;
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
      return undefined;
    }
  };

  // (T0-3) 세대 게이트 — FFI 세대가 캐시 세대와 다르면 스테일 캐시다.
  // getSchemaGeneration 미노출(구 RN JSI, Node stdio) 호스트는 게이트를
  // 건너뛴다(현상 유지). readLiveSchemaDocument 실패(schema.unavailable 등)는
  // 기존 lookup 폴백 계약을 유지하기 위해 삼킨다 — 이때 캐시는 그대로 둔다.
  const generationGate = (): void => {
    if (!native.getSchemaGeneration) return;
    let current: number;
    try {
      current = readGeneration(native.getSchemaGeneration());
    } catch {
      return;
    }
    if (cachedGeneration !== undefined && current === cachedGeneration) return;
    try {
      readLiveSchemaDocument();
    } catch {
      // 재조회 실패 시 기존 캐시 유지 — 다음 호출에서 재게이트한다.
    }
  };

  return { refreshLiveSchema, readLiveSchemaDocument, lookupCachedLiveSchemaEntry, generationGate };
}
