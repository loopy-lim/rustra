# DX 마찰 제거 트랙 설계 (dx-friction-track)

날짜: 2026-09-04
근거 리서치: docs/research/2026-09-04-dx-friction-audit-refresh.md (감사 선실행 — 사용자 지시)
상태: 사용자 승인 완료

## 목표

"개발자가 불편한 모든 것을 느끼지 못하게" — 마찰을 발견하는 메커니즘(정기 감사)과
마찰이 재발하지 못하게 하는 메커니즘(게이트)을 한 트랙에 함께 착지한다.

감사가 확정한 이번 트랙의 테마: **"조용한 성공/조용한 실패" 제거** — 사용자를
안심시킨 뒤 어긋나는 실패 경로의 품질(0.7 "신뢰" 테마와 정합).

범위 밖: readiness 트랙 소관(NDJSON 보존, 응답 셰이프, thiserror 문서, 문서 정직성
4건, 코드 위생, changeset 머지), 채널 4호스트 통합, 발행 승인(PR #51), 증거 격상(1.0),
on_unimplemented 구현(readiness Task 9a와 문서 문단 경합 — 9a 착지 후 다음 트랙).

## 착지 위치

- 워크트리 `.worktrees/dx`, 브랜치 `feat/dx-friction-track`
- 베이스 = `changeset-release/main` (bd72610b) — readiness 트랙과 동일 베이스로 격리.
  문서 충돌 가능성은 merge-tree 선검증.
- 푸시/머지는 사용자 승인 게이트 유지. 로컬 `changeset version` 실행 없음.

## 컴포넌트 A: E2E 첫성공 게이트 확장

- `scripts/onboarding-gate.mjs`의 5단계(init→doctor→build→codegen→demo) 뒤에
  3단계 추가 — "스키마 변경→재코드젠→재호출" 전 사이클을 CI 게이트화:
  - `mutate` — 스캐폴드의 Rust 계약 프로브에 실제 변경 주입(파라미터 1개 추가)
  - `regen` — `rustra codegen` 재실행
  - `verify` — 생성물에 변경 반영 확인(생성 commands.ts/types.ts에 신규 필드 존재)
    - 데모가 새 계약으로 동작하는지 확인
- 단계별 소요 시간 게이트 출력에 기록(로드맵 보조 지표 1 "온보딩 게이트 E2E 시간"의
  측정 기반). **임계값 게이트는 1차 범위 밖** (YAGNI).
- 적대적 재검증: regen이 반영 못 하는 변형 주입 → red 확인 → 원복.
- changeset: `@rustra/cli` minor (스캐폴드 수정을 동반하므로).

## 컴포넌트 B: 감사 확정 마찰 즉시 수정 (HIGH 7건 + MEDIUM 2그룹)

### B1. 첫 성공 경로의 깨진 계약 (CLI+E2E, 감사 #1/#3/#4)

1. **스캐폴드 `codegen:check` 항상 실패 수정** — init이 심는 generate bin이
   `RUSTRA_SCHEMA_OUT`을 존중하게 하거나(코어 측 `write_schema_to_dir` 계약 정합),
   check가 스캐폴드 구조와 맞게 동작. 스캐폴드에 심는 스크립트와 코어 계약의
   일치를 온보딩 게이트가 강제하는 구조로 종결.
2. **stale 런타임 바이너리 힌트** — codegen 성공 출력 끝에 "런타임 바이너리가
   생성 전이면 cargo build 후 실행" 안내 추가 + doctor freshness가 생성
   contract.ts 해시와 실제 빌드 산출물의 정합도 점검(가능 범위 내).
3. **init Next steps에 `cargo build` 추가** — 데모가 실제로 필요로 하는 단서 보완.
4. **doctor crates.io 도달성 검사 추가** — 네트워크 차단/프록시 환경에서
   cargo 콜드 빌드 실패 전에 진단 제공. (감사 #9의 ENOENT 힌트와 동일 축)

### B2. 생성물 표면의 조용한 계약 위반 (TS, 감사 #6/#7/#8)

5. **positional facade options 처리** — 미지원을 명시(시그니처 제거 또는
   전달 구현). "받아놓고 무시" 제거. 코드젠 렌더러 수정 + 생성물 재생성.
6. **positional facade 동기 throw → rejected Promise 정규화** —
   `Promise<T>` 선언과 런타임 계약 일치.
7. **타임아웃/미구성 에러 정규화** — JS 측 race가 base 에러 대신
   `TimeoutError`/`CancelledError` 서브클래스를 던지게 통일(경로별
   `instanceof` 불일치 제거) + 미구성 엔진 오류를 rejected Promise +
   `transport.unavailable` 코드로 통일(sync/async 이중 동작 제거).

### B3. 저작면의 조용한 드리프트 (Rust, 감사 #5)

8. **capability 무음 드랍 제거** — `.command_fn()` 경로에서
   `#[command(capability=...)]`이 소비되지 않으면 compile_error!(또는
   런타임 패닉 최소한 warn)로 승격. deny-by-default 계약 보존.
   wire round-trip 게이트로 재검증.

### B4. 문서 소문수 (감사 #2/#10, 빠른 것만)

9. **프로브 재생성 경로 실동행 정합** — 문서가 가르치는 `generate` bin을
   실제로 존재하게 하거나 문서를 실제 경로로 정정. 어느 쪽이든
   "문서대로 실행 → 실제 동작"이 되게. (en+ko 쌍 유지)
10. **게이트 밖 샘플 드리프트 소거** — contract.ts 해시 샘플·구형 multiline
    샘플을 실물로 갱신(가능하면 docs:sync 마커로 흡수) + README 타입 표
    `i64→number|bigint` 정정 + 버전 스니펫 3중 갈라짐 정정.

## 컴포넌트 C: 지속 리듬 명문화

- `docs/plans/2026-09-01-roadmap-design.md` "상시 실행 리듬" 절과 README 로드맵에
  **"마이너 발행 전 DX 감사 리프레시"** 한 줄 추가 — 마찰 회귀는 게이트가 잡고
  (자동), 새 마찰은 감사가 발굴하고(수동 리듬), 수정은 트랙으로 쌓는 이중 구조.
- 감사 리프레시는 2026-08-29 감사 → 2026-09-04 리프레시의 2례 구조가 원형.

## 명시적 큐잉 (다음 트랙 후보 — 이번에 안 함)

- on_unimplemented 구현 (S 규모 — readiness Task 9a 문서 정정과 같은 문단 경합)
- bun 데모 다중화(node/pnpm 사용자), CJS exports 조건, stringly-typed invoke
  CommandName 유니온, mock 출력 검증, dev `--format json`, vite 플러그인 문서,
  `generate --format json` shape 통일, Windows 백슬래시 경로, 디버그 블라인드
  스팟(RN fast path/async 왕복/수명주기), useEvent subscribe JSDoc 경고
- Electron/WASM/배치 항목별 취소 — 0.8 (로드맵 유지)

## 검증 게이트

- A: `onboarding-gate.test.ts` runner 주입 패턴 테스트 + 적대적 재검증
- B: 손대는 패키지별 `bun test` / `cargo test -p` + `cargo clippy --workspace
--all-targets -- -D warnings` + `cargo fmt --check` + 생성물 재생성
  (`codegen` 듀얼 경로 관례 — Rust bin + TS CLI)
- 최종: `bun run lint` + `test:docs` + `test:onboarding` + 적대적 재검증
- lefthook prettier 재스테이징 필요 시 amend 관례

## 커밋 순서

1. `docs(research,plans): DX 감사 리프레시 + 트랙 설계·계획`
2. `feat(cli): 온보딩 게이트 E2E 사이클 확장(mutate/regen/verify) + 타이밍`
3. `fix(cli): 스캐폴드 codegen:check 계약 정합 + Next steps 보완 + doctor 도달성`
4. `fix(codegen): stale 런타임 바이너리 힌트 + freshness 정합`
5. `fix(codegen): positional facade options 계약 정합 + rejected Promise 정규화`
6. `fix(types): 타임아웃/미구성 에러 정규화 — 서브클래스 통일`
7. `fix(macros): capability 무음 드랍 제거 — command_fn 경로 계약 강제`
8. `docs: 프로브 재생성 경로 실동행 정합 + 마커 밖 샘플 소거 + 타입표/버전 정정`
9. `docs(plans): 상시 리듬에 발행 전 DX 감사 리프레시 명문화`
10. `chore(changesets): DX 트랙 적립`

## 명시적 범위 밖

- readiness 트랙 소관 전부 (위 목표 절 참조)
- 브랜치 통합(feat/tauri-channel-adapter-work 등) — 사용자 결정 보류
- 로컬 `changeset version` 실행/푸시 승인 — 사용자 게이트
- 큐잉 목록 전부
