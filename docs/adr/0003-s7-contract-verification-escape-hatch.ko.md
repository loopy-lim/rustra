[English](./0003-s7-contract-verification-escape-hatch.md)

# ADR 0003 — S7 서술 정합: contractVerification 정책을 명시적 탈출구로 기록

- Status: Accepted
- Date: 2026-09-12
- Related: [ADR 0001](./0001-record-track-a-contract-mechanization.ko.md),
  [안전 계약 S7](../safety-contract.ko.md),
  `packages/types/src/frame-engine-options.ts`

## Status

Accepted — 2026-09-12. 행동 변경은 없다(정책 구현은 아래 참조). 이 기록은 안전
계약 문서를 이미 내려진 결정에 맞추는 서술 정합이다.

## Context

[ADR 0001](./0001-record-track-a-contract-mechanization.ko.md) Track A 항목 2가
`contractVerification: 'strict' | 'warn' | 'off'` 정책 옵션(기본 `undefined` ≡
`'strict'`)을 결정했고, 0.10.0에 구현됐다(`packages/types/src/frame-engine-options.ts`,
`frame-engine-contract.ts`의 `validateFrameEngineOptions`).

S7의 (a) 항과 "위반 시 동작" 문구는 이 결정보다 앞서 작성돼, 마치 우회 경로가
아예 없는 것처럼 읽힌다("검증 스킵 후 진행은 존재하지 않는다"). 실제 동작은:

- mismatch + `onContractMismatch` 콜백(T2) — 콜백 호출 후 degraded 모드로 계속
  (정책과 무관하게 콜백이 우선).
- mismatch/unenforceable + `'warn'` — 콘솔 경고로 강등 후 계속.
- `'off'` — `contractHash` 설정 여부와 무관하게 검증 생략.
- unenforceable + `'strict'`(기본) — 콜백으로도 우회 불가, 항상 throw.

문서-코드 불일치 자체가 계약 위반이므로([변경 규칙](../safety-contract.ko.md)),
현실로 문서를 옮기는 커밋도 ADR을 요구한다. 이 기록이 그 ADR이다.

## Decision

S7 (a)는 기본 정책에서의 fail-fast 동작을 기술한 뒤, `contractVerification`
옵션을 유일한 명시적·호출자 소유의 탈출구로 명시한다 — `'warn'` 은 degraded
계속, `'off'` 는 검증 생략. "위반 시 동작"은 스킵-후-진행이 오직 명시적 선택으로만
존재함을 말한다(조용한 스킵은 없음). unenforceable+strict의 무우회성과 노브의
범위(네이티브 Frame 엔진 한정, `contractHash` 없으면 검증 자체가 없음)도 함께
명시한다. 근거 코드에 `frame-engine-options.ts`의 정책 노브를 추가한다.

## Consequences

- 강제 코드는 무변경 — 이 기록은 ADR 0001이 결정하고 0.10.0이 배포한 동작에
  문서를 맞추는 것일 뿐이다.
- S7의 절대 문구("검증 스킵 후 진행은 존재하지 않는다")를 인용하던 독자는
  탈출구의 명시성(호출자가 옵션으로 선택해야만 발동)으로 해석을 갱신한다.
- 실패주입 매트릭스(`packages/types/src/index.test.ts` — A2/A3)가 세 모드 전부를
  이미 검증한다. en/ko 미러 쌍으로 작성·게이트된다.
