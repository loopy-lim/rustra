import { createSchemaPostcardCodec } from './schema-postcard-codec.js';
import { createComplexCodec } from './complex-codec.js';
import type { ComplexSchema } from './complex-codec-types.js';
import type { RkyvV2Codec } from './public.js';
import type { LiveSchemaEntry } from './live-schema.js';

/**
 * (T2-3) 동적 명령 binary 코덱 캐시 — Rust registry 의 3-way 판정
 * (command_build.rs)을 JS 엔진이 미러한다:
 *
 *   1. postcard 지원 스키마 → `createSchemaPostcardCodec` 인터프리터
 *      (Rust `js_codec_supported` 라우트와 동일 와이어).
 *   2. postcard 미지원이지만 complex 지원(oneOf payload enum 등) →
 *      `createComplexCodec` (Rust complex binary 라우트와 동일 와이어 —
 *      dynamic_oneof_schema_gets_complex_binary_handler 계약).
 *   3. 둘 다 거부(anyOf 3항 untagged 등) → null — 호출자가 기존 Tier 3
 *      (JSON-in-binary) 경로로 폴백한다. Rust `rkyv_v2_tier3=true` 와 정합.
 *
 * 캐시는 **entry 객체 식별**으로 무효화한다. generation 게이트(T0-3)가 live
 * schema 를 재조회하면 entry 도 새 객체가 되어 compute-if-absent 가 자연히
 * 새 스키마를 다시 판정한다 — replace/unregister 로 스키마 형태가 바뀌어도
 * 캐시가 스테일 와이어를 내지 않는다.
 */
export type DynamicCodecRuntime = {
  /** 동적 명령의 binary 코덱 — postcard/complex 순 판정, 미지원 null. */
  lookupBinaryCodec(entry: LiveSchemaEntry): RkyvV2Codec<unknown, unknown> | null;
};

export function createDynamicCodecRuntime(): DynamicCodecRuntime {
  const cache = new Map<LiveSchemaEntry, RkyvV2Codec<unknown, unknown> | null>();
  const lookupBinaryCodec = (entry: LiveSchemaEntry): RkyvV2Codec<unknown, unknown> | null => {
    if (cache.has(entry)) return cache.get(entry)!;
    const compiled = compileDynamicCodec(entry);
    cache.set(entry, compiled);
    return compiled;
  };
  return { lookupBinaryCodec };
}

function compileDynamicCodec(entry: LiveSchemaEntry): RkyvV2Codec<unknown, unknown> | null {
  const inputSchema = entry.inputSchema as ComplexSchema | undefined;
  const outputSchema = entry.outputSchema as ComplexSchema | undefined;
  if (!inputSchema || !outputSchema) return null;
  const definitions = entry.definitions ?? {};
  // 1순위: postcard 인터프리터 — 정적 명령 코드젠 코덱과 바이트 동일(PINNED
  // hex 교차 테스트). 미지원(oneOf/mixed/깊이 초과)이면 null.
  const postcard = createSchemaPostcardCodec(
    entry.commandId,
    inputSchema,
    outputSchema,
    definitions,
  );
  if (postcard) return postcard;
  // 2순위: complex 코덱 — Rust 가 oneOf payload enum 을 complex binary 로
  // 승격하는 것과 동일 판정. createComplexCodec 은 미지원 스키마를 **생성 시
  // throw** 하므로 try 로 잡아 Tier 3 폴백을 유지한다(양쪽 미러 불일치는
  // 안전 실패 — 와이어 오염 없음).
  try {
    return createComplexCodec({
      commandId: entry.commandId,
      inputSchema,
      outputSchema,
      definitions,
    });
  } catch {
    return null;
  }
}
