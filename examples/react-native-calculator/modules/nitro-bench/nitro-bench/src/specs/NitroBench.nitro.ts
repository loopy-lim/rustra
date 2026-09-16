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
  /** Contiguous byte-buffer comparison lane for Rustra's native buffer path. */
  echoBuffer(value: BufferPayload): BufferPayload
  echoPair(value: PairPayload): PairPayload
  benchAddAsync(value: AddPayload): Promise<AddResult>
  echoStringAsync(value: StringPayload): Promise<StringPayload>
  echoPairAsync(value: PairPayload): Promise<PairPayload>
  echoBufferAsync(value: BufferPayload): Promise<BufferPayload>
  parityEcho(value: ParityTree): ParityTree
  parityFind(value: ParityFindInput): ParitySearch
  parityStore(value: ParityTree): ParityStored
  parityResident(value: ParityQuery): ParitySearch
  parityIndexed(value: ParityQuery): ParitySearch
  parityEchoAsync(value: ParityTree): Promise<ParityTree>
  parityFindAsync(value: ParityFindInput): Promise<ParitySearch>
  parityStoreAsync(value: ParityTree): Promise<ParityStored>
  parityResidentAsync(value: ParityQuery): Promise<ParitySearch>
  parityIndexedAsync(value: ParityQuery): Promise<ParitySearch>
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

export interface BufferPayload {
  data: ArrayBuffer
}

export interface PairPayload {
  name: string
  value: number
}

// Nitrogen 0.37.1 recursive DTO pilot overflows; both implementations use this arena.
export interface ParityNode {
  id: number
  name: string
  tag: string
  note?: string
  metadata: Record<string, string>
  children: number[]
}
export interface ParityTree {
  nodes: ParityNode[]
}
export interface ParityFindInput {
  tree: ParityTree
  id: number
}
export interface ParityQuery {
  id: number
}
export interface ParitySearch {
  found: boolean
  id: number
  name: string
  visited: number
}
export interface ParityStored {
  nodes: number
}
