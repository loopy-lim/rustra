# Follow-up 2: RN/Lynx FastEngineOptions에 신규 엔진 옵션 전달

날짜: 2026-08-18 · 상위: docs/plans/2026-08-18-production-hardening-design.md 완료 노트 후속 (2)

## 개요

production hardening에서 core 엔진(`@rustra/types` `createRkyvV2Engine`)에 4개 신규 옵션이 추가됐다: `onContractMismatch`(OTA degraded 모드), `schemaVersion`+`onSchemaStale`(stale 경고), `maxPayloadBytes`(JS 사전 크기 검사). Node/Bun/Tauri 패키지는 core 팩토리를 re-export 하므로 자동 전달되지만, **RN(`@rustra/react-native`)과 Lynx(`@rustra/lynx`)은 `FastEngineOptions`를 별도 타입으로 수작업 재정의**해 `contractHash`만 전달하고 나머지 4개가 조용히 탈락한다. 이 plan은 누락 4개 옵션을 양 패키지에 전달하고, 같은 누수가 다시 생기지 않게 타입 수준에서 구조를 고정한다.

## 현재 상태 분석

### 주요 발견사항

- **core 옵션 정의**: `packages/types/src/index.ts:484-531` (`RkyvV2EngineOptions`) — `contractHash?`, `onContractMismatch?`, `schemaVersion?`, `onSchemaStale?`, `maxPayloadBytes?` 5개 전부. 각 옵션의 소비 로직: 계약 해시 검증(615-638), schemaVersion staleness(643-673), maxPayloadBytes 사전 검사(595-605 → tier2 696 / tier3 717 / 전파 764).
- **RN 누수 지점**: `packages/react-native/src/index.ts:128-135` — `createFastEngine`이 `createRkyvV2Engine(native, codecs, { contractHash: options.contractHash })` 로 4개 옵션 탈락. `createAsyncEngine`(208-261)도 내부에서 `createFastEngine`을 호출(212)해 같은 제한. 옵션이 optional 이라 core 시그니처가 조용히 통과시킨다 — **런타임 에러 없이 기능만 꺼지는 형태**.
- **Lynx 누수 지점**: `packages/lynx/src/index.ts:77-84` — 동일 패턴, 동일한 4개 탈락.
- **이미 전달되는 사례**: `packages/node/src/index.ts:20`, `packages/bun/src/index.ts:20`, `packages/tauri/src/index.ts:26` — core 팩토리 re-export. RN/Lynx만 수작업 필터링 구조.
- **취소(`signal`)는 누락 아님**: invoke 단위 옵션(`InvokeOptions`)으로 이미 배선 — 이 plan 범위 외.
- **테스트 공백**: `packages/react-native/src/index.test.ts`와 `packages/lynx/src/index.test.ts` 모두 옵션 전달 테스트 없음(lynx 테스트 헤더 주석이 "어댑터 고유 로직만 검증"이라 명시). 이번 누수가 조용히 지속된 직접 원인.
- **dist 동기화**: `packages/*/dist/index.d.ts` 가 커밋되어 있음 — 소스 수정 후 `npm run build` 재생성 필요 (메모리: generated/ 는 prettier 제외, 코드젠 듀얼패스).
- **문서화 표면**: `README.md` 에 `maxPayloadBytes`/`FastEngineOptions` 언급 존재 — 옵션 추가 시 문서 갱신 1회.

### 옵션별 현재 효과 (RN/Lynx에서 꺼져 있는 것)

| 옵션                 | core 동작                                       | RN/Lynx 현황                                                              |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `onContractMismatch` | 해시 불일치 시 throw 대신 콜백 후 degraded 진입 | 전달 안 됨 → OTA 조합에서 무조건 fail-fast throw                          |
| `schemaVersion`      | live schema 와 비교, JS > native 면 경고        | 전달 안 됨 → stale 감지 자체가 불가                                       |
| `onSchemaStale`      | stale 콜백 (미설정 시 console.warn)             | 위와 세트로 무효                                                          |
| `maxPayloadBytes`    | 인코딩 직후 사전 검사, `payload.too_large`      | 전달 안 됨 → 네이티브 최종 게이트만 동작 (Follow-up 1이 그 게이트를 보강) |

## 목표 상태

1. RN `FastEngineOptions`(packages/react-native/src/index.ts:81-88)과 Lynx `FastEngineOptions`(packages/lynx/src/index.ts:54-61)에 4개 옵션 추가 — core `RkyvV2EngineOptions`의 JSDoc 의미 그대로 이식.
2. 양쪽 `createFastEngine`이 옵션 전체를 core에 pass-through.
3. **타입 수준 방누수**: 각 패키지의 `FastEngineOptions`를 `rkyvV2Codecs` + core 옵션 전체를 포함하도록 구성(`Omit`/intersection 활용)해, core에 옵션이 추가돼도 컴파일 타임에 누수가 드러난다.
4. 옵션 전달 테스트 양측 추가 — mock 네이티브로 각 옵션의 core 도달을 검증.
5. `npm run build` 로 dist 재생성 + `test:packages` green.

## 범위 제한 (하지 않을 것)

- **JSON 폴백 엔진은 무관**: Lynx `createLynxEngine`(JSON 폴백)은 옵션을 소비하지 않는 경로 — 그대로 둔다.
- **`createAsyncEngine`의 얕은 취소 한계는 그대로**: RN async 엔진의 취소 전파(invokeTypedAsync id 노출)는 **Follow-up 3** 범위. 이 plan은 엔진 **생성 시점** 옵션만 다룬다.
- devtools 패키지(`createInstrumentedEngine`) 옵션 래핑 확장은 하지 않는다 — 요청된 적 없음.
- 문서 갱신은 README 옵션 표 1곳으로 한정 (풀 문서 트랙 아님).

## 구현 접근 방식

누수의 근본 원인은 "수작업 재정의 + 선택적 전달"이다. 각 패키지가 core 옵션 타입을 **구조적으로 참조**하게 만들면(필드 복붙이 아니라 타입 연산), core에 옵션이 추가될 때마다 pass-through 누락이 타입 에러/테스트로 드러난다. RN은 `import('@rustra/types')` 인라인 타입을 이미 쓰고 있고(infer 스타일), Lynx는 명시 import — 두 패키지 모두 다음 형태로 통일한다:

```ts
import type { RkyvV2EngineOptions } from '@rustra/types';

export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, RkyvV2Codec<unknown, unknown>>;
} & RkyvV2EngineOptions;

// createFastEngine 내부:
return createRkyvV2Engine(native, options.rkyvV2Codecs, {
  contractHash: options.contractHash,
  onContractMismatch: options.onContractMismatch,
  schemaVersion: options.schemaVersion,
  onSchemaStale: options.onSchemaStale,
  maxPayloadBytes: options.maxPayloadBytes,
});
```

`RkyvV2EngineOptions` 필드는 전부 optional 이므로 intersection 은 기존 호출(옵션 없음/contractHash 만)과 하위 호환된다. pass-through 가 명시적 필드 나열이 된 것은 의도적이다 — 컴파일은 통과하되 "전달을 까먹으면 테스트가 잡는" 이중 안전장치. 여기에 "core 옵션 전체가 전달되는지" 컴파일 타임 검증을 하나 더 얹는다:

```ts
// 방누수 컴파일 타임 가드 — core 에 옵션이 추가되면 이 줄이 타입 에러를 낸다.
const _exhaustivePassThrough: RkyvV2EngineOptions = {
  contractHash: options.contractHash,
  onContractMask: options.onContractMismatch, // ← 실수 사례 (구현 시 정확히)
  ...
};
```

(구현 시 오타 없이 정확히 작성 — 컴파일 타임 excess-property 검사로 core 필드 누락/오타를 잡는다. `satisfies RkyvV2EngineOptions` 를 쓰는 방법도 동일 효과.)

명시 나열 + `satisfies` 조합이 이 코드베이스 관례(명시적 스타일)에 맞다. 단일 Phase 로 구현한다.

## Phase 1: RN + Lynx 옵션 전달 + 방누수 가드 + 테스트

### 개요

양 패키지 `FastEngineOptions` 재구성, `createFastEngine` pass-through, 컴파일 타임 가드, 옵션 전달 테스트, dist 재빌드.

### 필요한 변경사항:

#### 1. `packages/react-native/src/index.ts`

**변경사항**:

- import 에 `RkyvV2EngineOptions` 타입 추가 (기존 `import type { … } from '@rustra/types'` 라인).
- `FastEngineOptions` 재정의(81-88):

```ts
/**
 * 고속 엔진 생성 옵션.
 *
 * rkyv V2 바이너리 경로를 필수로 사용합니다 (최고 성능). 나머지 필드는
 * core `RkyvV2EngineOptions` 를 그대로 전달한다 — contractHash 검증(F5),
 * onContractMismatch/schemaVersion/onSchemaStale(OTA, T2), maxPayloadBytes(T3).
 */
export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, import('@rustra/types').RkyvV2Codec<unknown, unknown>>;
} & RkyvV2EngineOptions;
```

- `createFastEngine`(128-135) pass-through:

```ts
export function createFastEngine(
  native: RustraJSINative,
  options: FastEngineOptions,
): EngineClientType {
  // 명시 나열 + satisfies — core 에 옵션이 추가되면 이 객체 리터럴이 누락
  // 필드/오타를 타입 에러로 드러낸다 (수작업 필터링 누수 방지).
  const engineOptions = {
    contractHash: options.contractHash,
    onContractMismatch: options.onContractMismatch,
    schemaVersion: options.schemaVersion,
    onSchemaStale: options.onSchemaStale,
    maxPayloadBytes: options.maxPayloadBytes,
  } satisfies RkyvV2EngineOptions;
  return createRkyvV2Engine(native, options.rkyvV2Codecs, engineOptions);
}
```

(구현 시 들여쓰기 오타 없이 — `satisfies` 는 TS4.9+, 프로젝트 TS 버전 확인 후 사용. 불가하면 타입 어노테이션 방식.)

- `createAsyncEngine`(208)은 `createFastEngine` 재사용이라 자동 승격 — 코드 불변.

#### 2. `packages/lynx/src/index.ts`

**변경사항**: RN 과 동일 구조.

- import 에 `RkyvV2EngineOptions` 추가.
- `FastEngineOptions`(54-61) 재구성 + `createFastEngine`(77-84) pass-through (위와 동일한 `satisfies` 패턴).

#### 3. 테스트 추가

**파일**: `packages/react-native/src/index.test.ts`, `packages/lynx/src/index.test.ts`
**변경사항**: 각 파일에 "옵션 전달" 섹션 추가. mock 네이티브가 옵션 효과를 관찰할 수 있는 최소 검증:

```ts
// (RN 예시 — Lynx 도 동일 관례)
test('createFastEngine forwards maxPayloadBytes to core pre-check', async () => {
  // maxPayloadBytes: 8 → 인코딩 후 8B 초과면 payload.too_large 로 네이티브 호출 없이 reject
  const native = {
    invokeRkyvV2: () => {
      throw new Error('must not be called');
    },
  };
  const codec = { commandId: 1, encode: () => new ArrayBuffer(16), decode: () => ({ ok: true }) };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map([['big', codec]]),
    maxPayloadBytes: 8,
  });
  await assert.rejects(
    engine.invoke('big', {}),
    (err) => err instanceof RustraCommandError && err.code === 'payload.too_large',
  );
});

test('createFastEngine forwards schemaVersion/onSchemaStale (stale warning path)', async () => {
  const stale: unknown[] = [];
  const native = {
    invokeRkyvV2: () => new ArrayBuffer(8),
    getSchema: () => encoder.encode(JSON.stringify({ schemaVersion: 1, commands: [] })).buffer,
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map(),
    schemaVersion: 4,
    onSchemaStale: (info) => stale.push(info),
  });
  // 엔진 생성 시점에 검사가 돈다 — stale 이 기록돼 있어야 한다.
  assert.deepEqual(stale, [{ nativeVersion: 1, jsVersion: 4 }]);
});

test('createFastEngine forwards onContractMismatch (degraded mode entry)', () => {
  const mismatches: unknown[] = [];
  const native = {
    invokeRkyvV2: () => new ArrayBuffer(0),
    getContractHash: () => encoder.encode('native-hash-AAAA').buffer,
  };
  const engine = createFastEngine(native, {
    rkyvV2Codecs: new Map(),
    contractHash: 'different-hash-BBBB',
    onContractMismatch: (info) => mismatches.push(info),
  });
  assert.ok(engine, 'degraded mode — engine is created instead of throwing');
  assert.deepEqual(mismatches, [
    { nativeHash: 'native-hash-AAAA', expectedHash: 'different-hash-BBBB' },
  ]);
});
```

(core 옵션 테스트가 types 패키지에 이미 있으므로(565-730 등), 어댑터 테스트는 "전달됐는지"만 검증한다 — core 동작 상세는 재검증하지 않는다. Lynx 테스트 헤더 주석("어댑터 고유 로직만 검증")도 이 관례에 맞게 갱신.)

#### 4. 빌드/문서

- `npm run build` — dist 재생성 (`test:packages` 가 dist 기반으로 돌므로 필수).
- `README.md` 의 FastEngineOptions/maxPayloadBytes 언급 갱신 (옵션 표에 4개 추가 — 위치는 구현 시 확인).

### 성공 기준:

#### 자동 검증:

- [ ] `npm run build` 성공 (양 패키지 dist 재생성)
- [ ] `npm run test:packages` green — react-native/lynx 신규 옵션 전달 테스트 3종 포함
- [ ] `npm run test:types` green (core 무변경이므로 회귀만)
- [ ] `npx tsc -p packages/react-native --noEmit` / `npx tsc -p packages/lynx --noEmit` (또는 각 패키지 빌드 타입체크) 통과 — `satisfies` 가드 포함
- [ ] `npm run lint` 0 warn
- [ ] `npm run test -w @rustra/cli` green (무관하나 전체 게이트)
- [ ] `npm run test:ts:node` green (무관하나 전체 게이트)

#### 수동 검증:

- [ ] core `RkyvV2EngineOptions` 에 실험적으로 필드 1개 추가 시 RN/Lynx 어댑터 빌드가 누수를 잡는지 확인 (구현 완료 후 로컬 1회 검증 후 원복 — 방누수 가드 효과 증명)
- [ ] README 옵션 문서가 실제 시그니처와 일치

## 테스트 전략

### 단위 테스트 (양 패키지 공통)

- `maxPayloadBytes` 전달 → 사전 검사 reject (네이티브 미호출)
- `schemaVersion` + `onSchemaStale` 전달 → 엔진 생성 시점 stale 기록
- `onContractMismatch` 전달 → degraded 진입 (throw 대신 엔진 반환)
- 부작용 없는 baseline: 옵션 전혀 없이 생성 → 기존 동작 유지 (하위 호환)

### 통합 테스트

- 기존 `test:packages` 스위트가 dist 기반 전수 재검증 — 새 옵션이 기존 엔진 동작을 깨지 않는지.

### 수동 테스트 단계

1. RN 예제 앱(`examples/react-native-calculator`) 타입체크: `npm run test:app:react-native` — 예제가 FastEngineOptions 를 쓰는 위치에서 새 옵션 타입이 충돌 없는지.
2. Lynx 예제(desktop verify 스크립트) — 필요 시 `npm run verify:desktop` (구현 시 판단, Rust 빌드 동반).

## 성능 고려사항

엔진 생성 시점 1회 옵션 검사 — invoke hot path 무변경. `maxPayloadBytes` 사전 검사는 기존 core 로직 재사용.

## 마이그레이션 참고사항

- `FastEngineOptions` 는 필드 추가만 있으므로 **하위 호환** — 기존 호출(`{ rkyvV2Codecs, contractHash }`)은 그대로 컴파일/동작.
- dist 가 커밋되어 있으므로 `npm run build` 후 커밋에 포함 (pre-commit prettier 훅 — 재스테이징/amend 필요, 메모리 참조).

## 참고 자료

- core 옵션 정의: `packages/types/src/index.ts:484-531`
- RN 누수 지점: `packages/react-native/src/index.ts:128-135`
- Lynx 누수 지점: `packages/lynx/src/index.ts:77-84`
- core 옵션 테스트 (전달 후 동작 보증): `packages/types/src/index.test.ts:565-730, 1124-1270`
- re-export 사례 (node/bun/tauri): `packages/node/src/index.ts:20`
