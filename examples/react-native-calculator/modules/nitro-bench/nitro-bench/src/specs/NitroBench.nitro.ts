import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBench extends HybridObject<{
  ios: 'c++'
  android: 'c++'
}> {
  /** Nitro의 원시 인자 lower bound. rustra command와 직접 ratio를 내지 않는다. */
  add(a: number, b: number): number
  /** 아래 네 메서드는 rustra bench* 명령과 입출력 모양·연산이 같다. */
  benchAdd(value: AddPayload): AddResult
  echoString(value: StringPayload): StringPayload
  echoBytes(value: BytesPayload): BytesPayload
  echoPair(value: PairPayload): PairPayload
}

export interface AddPayload {
  a: number
  b: number
}

export interface AddResult {
  value: number
}

export interface StringPayload {
  value: string
}

export interface BytesPayload {
  data: number[]
}

export interface PairPayload {
  name: string
  value: number
}
