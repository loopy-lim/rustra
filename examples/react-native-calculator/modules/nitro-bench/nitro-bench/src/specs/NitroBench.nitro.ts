import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBench extends HybridObject<{
  ios: 'c++'
  android: 'c++'
}> {
  add(a: number, b: number): number
  echo(value: number): number
  /** Tier 2 — string 마셜링(왕복) */
  echoString(value: string): string
  /** bytes — ArrayBuffer 마셜링(왕복). rustra bytes(Vec<u8>) 경로와 대응. */
  echoBuffer(value: ArrayBuffer): ArrayBuffer
  /** 객체 변형 — Nitro 가 구조체를 어떻게 넘기는지(원시 필드 분해 vs 직렬화) */
  echoPair(value: PairPayload): PairPayload
}

/** 벤치용 단순 구조체 — rustra createItem 계열과 대응하는 형태. */
export interface PairPayload {
  name: string
  value: number
}
