// ── rustra generated ────────────────────────────────────────
// File:   types.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

/**
 * 커맨드 인자로 받은 채널 핸들 — serde 표면은 plain `u32`다.
 *
 * 코드젠은 이 타입을 인식하면 TS 를 `RustraChannel` 마커 타입으로 발행한다(런타임 값은 여전히 number — wire 는 u32 varint).
 */
export type ChannelHandle = number;

export type Item = {
  active: boolean;
  name: string;
  value: number | bigint;
};

export type OpKind = 'Clear' | {
  Set: {
  value: number | bigint;
};
};

/**
 * 커맨드 반환값/필드로 받은 리소스 핸들 — serde 표면은 plain `u32`.
 */
export type ResourceHandle = number;

export type AddNumbersInput = {
  a: number | bigint;
  b: number | bigint;
};

export type AddNumbersOutput = {
  value: number | bigint;
};

export type BenchAddInput = {
  a: number;
  b: number;
};

export type BenchAddOutput = {
  value: number;
};

export type BenchBytesPayload = {
  data: Uint8Array | ArrayBuffer | number[];
};

export type BenchPairPayload = {
  name: string;
  value: number;
};

export type BenchStringPayload = {
  value: string;
};

export type ChannelDemoInput = {
  /** 호스트가 발급한 채널 핸들 — JS 콜백이 이 번호에 배선돼 있다. */
  channel: ChannelHandle;
  ticks: number;
};

export type ChannelDemoOutput = {
  sent: number;
  /** 만료된 핸들로의 send 시도 수(stale 무시 계약의 가시화). */
  droppedSends: number;
};

/**
 * 바이너리 채널 데모 — `channel_demo` 의 바이트 경로 쌍둥이. 모든 호스트 어댑터의 createBytesChannel/createChannelBytes 패리티를 동일 명령으로 e2e 검증한다(페이로드는 스텝 카운터 LE u64).
 */
export type ChannelDemoBytesInput = {
  /** 바이너리 채널로 발급받은 핸들. */
  channel: ChannelHandle;
  /** 전송할 프레임 수. */
  ticks: number;
};

export type ChannelDemoBytesOutput = {
  sent: number;
  droppedSends: number;
};

export type ClampInput = {
  max: number;
  min: number;
  value: number;
};

export type ClampOutput = {
  value: number;
};

export type CreateItemInput = {
  name: string;
  value: number | bigint;
};

export type CreateItemOutput = {
  item: Item;
};

/**
 * 디바이스 역량 계약 — 커맨드가 전제하는 디바이스 역량 선언의 예시.
 *
 * `device_demo` 는 `#[command(device(camera, bluetooth))]` 로 카메라·블루투스를 전제한다고 선언한다. 선언은 schema.json 의 조건부 `devices` 필드와 생성 `devices.ts`(토큰 유니언 + 커맨드별 요구 상수)의 원천이 될 뿐 런타임 게이팅은 하지 않는다 — 하드웨어 접근·권한 확인은 호스트 앱이 getDeviceStatus 로 사전 조회하는 패턴의 뼈대가 되는 예시다(여기서는 하드웨어에 접근하지 않는다).
 */
export type DeviceDemoOutput = {
  /** std::env::consts::OS — 선언과 무관한 컴파일 대상 확인용. */
  os: string;
};

export type DivideInput = {
  a: number | bigint;
  b: number | bigint;
};

export type DivideOutput = {
  value: number | bigint;
};

export type EchoGroupsInput = {
  groups: Record<string, string[]>;
};

export type EchoGroupsOutput = {
  groups: Record<string, string[]>;
};

export type EmitDemoInput = {
  /** 발행할 progress.tick 이벤트 수. */
  ticks: number | bigint;
  /** 각 스텝 사이 대기 (ms). 데모에서 이벤트 순서를 관찰하기 쉽게. */
  stepDelayMs: number | bigint;
};

export type EmitDemoOutput = {
  emitted: number | bigint;
};

export type GaugeInput = {
  limit: number | bigint;
  offset: number;
};

export type GaugeOutput = {
  next: number | bigint;
};

export type GreetInput = {
  name: string;
};

export type GreetOutput = {
  message: string;
};

export type IsEvenInput = {
  n: number | bigint;
};

export type IsEvenOutput = {
  result: boolean;
};

export type KindEchoInput = {
  kind: OpKind;
};

export type KindEchoOutput = {
  echoed: OpKind;
};

export type MultiplyInput = {
  a: number;
  b: number;
};

export type MultiplyOutput = {
  value: number;
};

/**
 * 플랫폼 상호운용 — 플랫폼 특화 명령의 계약 안정화 예시.
 *
 * `platformNativeInfo` 는 `#[command(platform(windows, macos))]` 로 macos/windows 에만 구현을 선언한다. 등록(id·스키마·계약 해시)은 전 플랫폼에서 동일하게 일어나고, Linux(및 기타)에서 호출하면 `platform.unavailable` 이 반환된다 (`command.not_found` 와 구분된다). 실제 구현은 cfg 로 보호해 지원 OS 에서만 주입된다 — win32/objc2 호출을 하는 실명령의 뼈대가 되는 패턴이다.
 */
export type PlatformNativeInfoOutput = {
  /** std::env::consts::OS — 컴파일 대상 OS 문자열. */
  os: string;
  /** 네이티브 윈도우 시스템 식별자 — 실제 예에서는 win32/objc2 API 조사값. */
  windowKind: string;
};

export type ProcessItemInput = {
  item: Item;
};

export type ProcessItemOutput = {
  doubled: boolean;
  item: Item;
};

export type ResourceCloseInput = {
  handle: ResourceHandle;
};

export type ResourceCloseOutput = {
  closed: boolean;
};

export type ResourceOpenInput = {
  initial: Record<string, string>;
};

export type ResourceHandleOutput = {
  handle: ResourceHandle;
};

export type ResourceReadInput = {
  handle: ResourceHandle;
  key: string;
};

export type ResourceReadOutput = {
  found: boolean;
  value?: string | null;
};

export type ResourceWriteInput = {
  handle: ResourceHandle;
  key: string;
  value: string;
};

export type ResourceWriteOutput = {
  entries: number;
};

export type RegistryDemoInput = {
  op: string;
};

export type RegistryDemoOutput = {
  ok: boolean;
  frozen: boolean;
  message: string;
};

export type ScoreTotalInput = {
  scores: Record<string, number | bigint>;
};

export type ScoreTotalOutput = {
  count: number;
  total: number | bigint;
};

export type SecureComputeInput = {
  a: number | bigint;
  b: number | bigint;
};

export type SecureComputeOutput = {
  value: number | bigint;
};

export type SizeOfInput = {
  data: Uint8Array | ArrayBuffer | number[];
};

export type SizeOfOutput = {
  checksum: number;
  len: number;
};

export type SpanInput = {
  pair: [string, number | bigint];
};

export type SpanOutput = {
  first: string;
  second: number | bigint;
};

export type SumListInput = {
  numbers: (number | bigint)[];
};

export type SumListOutput = {
  count: number;
  total: number | bigint;
};

export type TagSetInput = {
  ids: Set<number | bigint>;
};

export type TagSetOutput = {
  tags: Set<string>;
};

export type ToUpperInput = {
  s: string;
};

export type ToUpperOutput = {
  result: string;
};

/**
 * A2 와이드 정수 복합 타입 표본 — Vec<u64> + Option<i64>. 원소/옵션 레벨 uvar64/zigzag64 헬퍼가 스트림 중간 7바이트 varint 경계를 넘는 값을 무손실 왕복하는지 cross-wire 픽스처로 고정한다.
 */
export type WideAggInput = {
  samples: (number | bigint)[];
  offset?: number | bigint | null;
};

export type WideAggOutput = {
  max: number | bigint;
  adjusted: number | bigint;
};
