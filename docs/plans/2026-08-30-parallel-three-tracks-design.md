---
date: 2026-08-30
author: loopy-lim
status: approved
type: parallel-tracks
priority: high
---

# 병렬 3트랙 설계 (DX / Perf / Events)

## 문제

2026-08-29 DX 감사(`thoughts/shared/research/2026-08-29_22-46-49_dx-audit.md`)와
perf 5트랙 스펙(`docs/superpowers/specs/2026-08-29-perf-five-tracks-design.md`)이
남긴 세 축 — DX HIGH 결함, 성능 최적화, 이벤트 표면 완결 — 을 한 번에 진행한다.

## 구조: 3워크트리 병렬

| | DX | Perf | Events |
|---|---|---|---|
| 브랜치 | `feat/dx-hardening` | `feat/perf-five-tracks` | `feat/event-surface` |
| 근거 | 감사 HIGH 테이블 | 기존 스펙 그대로 계약 | 감사 §1.2 + 성장 조사 E-1/E-2/E-4 |
| 차단 | 없음 | 없음 | Perf host 머지 후 rebase |

### 파일 소유권 (엄격 분리)

- **DX**: `packages/cli/**`, `docs/**`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `packages/types/src/errors.ts` + debug env
- **Perf**: `crates/rustra/**`(complex_codec/command/executor), `packages/types/src/rkyv-engine.ts`·`complex-codec.ts`, `packages/bun/**`, node transport / tauri dispatch 영역, RN cpp
- **Events**: `crates/rustra-macros` + 코드젠, node/bun/tauri `subscribeEvent` **신규 API**, `docs/compatibility-matrix.md`

### 충돌 파일

- `packages/node/src/index.ts`: Perf=NDJSON→바이너리 프레이밍(transport 내부) / Events=subscribeEvent 신규 export — 함수 단위 분리
- `packages/tauri/src/index.ts`: Perf=rustra_dispatch_batch / Events=채널 subscribeEvent — 동일 분리
- `packages/types`: Perf=rkyv-engine.ts·complex-codec.ts / DX=errors.ts — 파일 단위 분리

### 머지 순서 고정

`Perf(crates 소유) → DX → Events(rebase 후)`. crates를 건드리는 건 Perf뿐.

## 각 트랙 범위

### DX (`feat/dx-hardening`)

1. CLI arg-parser 통일 (4중복 → 1헬퍼; --help/exit 2/--flag=value 동시 해소)
2. CLI 인체공학: codegen 스피너+경과, init 덮어쓰기 차단+`--force`, 스캐폴드 .gitignore/tsconfig, config 오타키 loud-fail, help 보강
3. errors.ts: cause 옵션+보존, Timeout/Cancelled 서브클래스
4. `RUSTRA_DEBUG` 와이어 덤프 (node/bun/tauri 공통)
5. 문서 HIGH 6건 (README init, rust-api-guide 예제 2건, CONTRIBUTING 릴리스, divide 시그니처, CHANGELOG 요약)
6. Rust 저작면: 코드젠 unknown 폴백 loud-fail, `__RUstra_doc_` → TS JSDoc 전달 활성화

### Perf (`feat/perf-five-tracks`)

기존 스펙이 계약. 트랙 A(스키마 사전컴파일) → B(serde 어댑터) → Bun fast-path → Node 바이너리 프레이밍 → Tauri 측정 정합화 → RN 잔여 → 트랙 T(generation 계약 + 동적 postcard).

게이트: PINNED wire fixture byte-exact, addNumbers 2.9µs→≤1µs, Bun 2.27µs→1µs 내외, Node 16.9µs→3-6µs, cargo test + test:ts:node + C++ codec tests, 벤치 영수증(세션 조건 기재).

### Events (`feat/event-surface`)

1. 타입 안전 이벤트 코드젠 (schema events 섹션 → 유니온 생성, diff 게이트 정합)
2. Node/Bun `subscribeEvent` (node는 drainEvents 폴링 래핑, bun 신규)
3. Tauri 채널 `subscribeEvent` + 어댑터 시그니처 수렴 (node :177-198 vs RN :458-527)
4. compatibility-matrix 갱신 ❌→✅

## 범위 밖 (기능 트랙과 무관)

배치 항목별 취소, async 실행기 주입, 프리빌트/WASM/Windows, 영어 문서.

## 4단계 — 버전업 + 열린 PR 통합 (2026-08-30 목표 추가)

사용자 목표: "테스트와 실제 성능 테스트까지, 완료 판정 시 열려 있는 PR에 통합, 버전 불일치로 막히는 일 없이 버전업 전부 진행".

1. **버전 스큐 해소**: 대기 changeset(`.changeset/quiet-bridges-check.md`)이 전부 patch라
   testing/devtools/react 0.4.1의 `@rustra/types ^0.5.0` 의존이 해소되지 않음 → `@rustra/types`
   minor(0.5.0)로 상향한 changeset으로 교체. 3트랙 변경분을 커버하는 changeset을 패키지별로
   작성(cli/types/node/bun/testing/devtools/react/tauri/react-native + crates).
2. **검증**: 각 트랙 테스트 게이트 + Perf는 실측 벤치 영수증(세션 조건 기재)까지.
3. **통합**: 머지 순서 Perf→DX→Events로 main에 반영 → changesets action이 유지하는
   버전 packages PR(#46)이 전 changeset을 흡수해 최종 상태 = "모든 작업 + 버전업이 열린 PR에 통합".
4. PR #46의 실제 머지/발행(npm·crates.io publish)은 사용자 최종 승인 후.

## 실행 프로토콜

- 워크트리 3개 + 트랙별 배경 에이전트 1개씩; 메인 세션은 조율+적대적 재검증
- 소유 파일만 수정 — 경계 침범 항목은 이슈로 남기고 건너뜀
- 커밋 관례: `feat(dx):`/`perf(x):`/`feat(events):` + lefthook prettier 후 **amend 필수**
- 검증 게이트 통과가 완료의 유일한 기준 (CI green ≠ 결함 없음 — 메인에서 재검증)

## 사후

3트랙 머지 후 통합 게이트 재실행 → compatibility-matrix 최종 점검 → plan 체크박스 갱신(문서-현실 불일치 방지) → changeset 별도 승인.
