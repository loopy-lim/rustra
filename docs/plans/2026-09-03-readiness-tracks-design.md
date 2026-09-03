# Production readiness 트랙 설계 (readiness-tracks)

날짜: 2026-09-03
근거 리서치: docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md
상태: 사용자 승인 완료 (버전 커밋 없이 changeset만 적립, 머지 후 푸시)

## 목표

production readiness 갭 중 "미통합·미착지" 5개 부류를 한 트랙에서 해소한다:
버전 정책 minor-only 개정, 계약 게이트 필드 수준 강화, React Suspense 캐시,
에러/디버깅 품질 4건, 문서 정직성 4건, 코드 위생.

범위 밖: 브랜치 통합(사용자 결정 보류), 레거시 제거(별도 진행 — 이미 커밋 착지 중),
발행 승인(Version PR 머지는 사용자 게이트), 증거 격상(실기기 — 1.0 트랙).

## 브랜칭·발행 흐름

- 워크트리 `.worktrees/readiness`, 브랜치 `feat/readiness-tracks`.
- **베이스 = `changeset-release/main` (bd72610b)** — 0.7.0 version 커밋 1개 +
  ebfac5e9. main-line 미머지 커밋(+29)·레거시 제거 진행 커밋과 완전 격리된다.
- 트랙별 커밋 그룹 순차 착지 → 전면 게이트 → `changeset-release/main`에 로컬 머지
  (fast-forward 또는 merge 커밋) → 푸시. **PR 머지는 계속 사용자 승인 게이트.**
- **로컬 버전 커밋 실행 없음** (사용자 지정). 신규 changeset은 0.7.0 version 커밋
  위에 적립만 하고, 다음 `changeset version` 실행 시 minor bump로 귀결된다.
  "1.0 전까지 minor를 계속 올린다"는 발행 리듬과 정합.
- 리서치 문서와 본 설계 문서도 이 브랜치에서 커밋.

## 트랙 1: 버전 정책 문서 개정 (사용자 지시)

"1.0 전까지는 breaking도 마이너로 흘러가게" — 현재 표의 공개 Rust/TS API 행만
"메이저 버전" 단수 요구로 pre-1.0 경로가 없어 막혀 있다.

- `docs/versioning-policy.md` + `.ko.md` 호환성 보장 범위 표:
  - 공개 Rust API 행의 Breaking change 요구 조건 → "메이저 버전. Pre-1.0:
    마이그레이션 노트를 동반한 마이너." (와이어 포맷 행과 동일 문구로 정렬)
  - 공개 TypeScript API 행 동일.
- "릴리즈 번호 체계" 절에 원칙 명문화: 1.0까지는 보장 표면의 breaking이
  마이그레이션 노트와 함께 마이너로 발행되며, 1.0부터 이 허용은 소멸한다.
- 배경 정합: 대기 changeset `next-cycle-integration.md`의 type-level breaking
  2건이 이 경로로 발행된다. `docs/migrations/`의 기존 마이그레이션 문서 관례가
  이미 이 운영 방식의 증거다.

## 트랙 2: 계약 게이트 필드 수준 강화 (DX audit HIGH)

- `packages/testing/src/contract-gate.ts`는 명령 **이름 집합**만 비교한다
  (contract-gate.ts:10-20). 필드 추가/삭제·타입 변경이 감지 안 된다.
- 확장 설계:
  - 생성 커맨드의 **순서 있는 파라미터 필드** 검증 — 코드젠이
    `createGeneratedFields2(id, name, "a", "b", ...)` 형태로 필드 이름을
    심으므로, 이를 런타임에 읽어 schema.json의 `parameters`와 대조한다.
    (정확한 심음 형태는 examples/calculator/generated/commands.ts에서 확인)
  - **contract hash 대조** — schema.json의 contract hash와 생성 contract.ts
    (존재 시)의 hash가 갈라지면 타입 변경 감지. contract hash 이원화 결함
    교훈([[contract-hash-divergence-defect]])의 게이트화.
- 하위호환: 기존 `(schema, clientCommands: string[])` 시그니처는 유지 —
  생성물을 못 읽는 소비자는 기존 이름만 비교로 폴백한다. 신규 API는 별도 함수
  (`assertContractFieldsCurrent` 계열)로 추가.
- changeset: `@rustra/testing` minor.

## 트랙 3: React Suspense 캐시/무효화 1차 (DX audit HIGH)

- `packages/react`에 `useSuspenseCommand` 신설 — promise-throwing 패턴
  (React 18/19 양립, use 트랜지션 비의존).
- 캐시 키 = `commandId::inputKey(input)` (input-key.ts 재사용 — bigint 안전).
- 무효화: 모듈 레벨 캐시에 `invalidate(commandName?)` / 전체 무효화 제공,
  `useMutation` 성공 콜백에서 쓸 수 있게 한다.
- 진화 정책(LRU 등)은 1차 범위 밖 (YAGNI — 로드맵 0.8 "훅 2세대" 후속).
- changeset: `@rustra/react` minor.

## 트랙 4: 에러/디버깅 품질 4건 (0.7 "신뢰" 잔여)

1. **withRetry** — `@rustra/types`에
   `withRetry(fn, { retries, baseDelayMs, signal, retryIf })`. 지수 백오프,
   기본 판정 `isRetryableCode`(errors.ts:121-123 재사용). 테스트 포함.
2. **NDJSON 실패 라인 보존** — `packages/node/src/node-loop.ts:270-275`의
   `catch { continue; }`를 원본 라인 링버퍼 보존 + `RUSTRA_DEBUG` 시 warn으로.
   :283 stderr 폐기도 debug 모드에서 보존. push 이벤트 경로
   (node-events.ts:175-181)의 기존 warn 관례를 따른다.
3. **응답 셰이프 검증 경고** — JSON 엔벨로프(`{ok,...}`) 이탈과 typed 커맨드의
   undefined 응답을 debug 모드에서 warn. 버전 스큐 조기 감지용.
   debug.ts의 기존 스위치(`debugRustra`/`traceWire`) 재사용.
4. **thiserror 에러 매핑 문서화** — rust-api-guide(.ko/.md)에 커스텀 에러
   enum → TS 코드 매핑 패턴 절 신설. 실제 동작 앵커(코드젠 description→JSDoc
   경로 등)를 먼저 확인하고 문서가 거짓말하지 않게 한다.
- changeset: `@rustra/types` minor (withRetry), `@rustra/node` minor
  (NDJSON/셰이프 경고).

## 트랙 5: 문서 정직성 4건

1. **over-claim 정정** — `docs/rust-api-guide.md:140`(+`.ko.md:138`)
   on_unimplemented "friendly error" 서술을 실제 상태로 정정. 레거시 제거
   트랙(별도 진행)과 겹치는 항목 — 워크트리에서 착지 시점에 레거시 측 커밋이
   이미 이걸 고쳤는지 확인 후 중복 정정 회피.
2. **루트 CHANGELOG 0.6 요약 보강** — 현재 0.5에서 정지. 6패키지 0.6.0
   발행 현실과 `docs/migrations/0.5-to-0.6.md` 존재를 반영해 "0.6" 요약 추가.
3. **`docs/compatibility-contract.ko.md` 신설** — 유일한 en-only 가이드
   (en+ko 쌍 규칙 위반). en 원문 번역 + docs/README(.ko).md 링크 갱신.
4. **docs-gate warn → fail 전환** — `scripts/docs-gate.mjs:64,234`의 미결
   "fail 전환은 후속 판단 사항"을 소처분. 전환 + 게이트 테스트 갱신 +
   적대적 재검증(일부러 어긋나게 해 red 확인 → 원복).
- changeset 없음 (문서/스크립트).

## 트랙 6: 코드 위생

- **deprecated 3표면** — 제거는 정책 요건("최소 1 마이너 유지") 검증이 선행:
  - `RendererHost` (crates/rustra/src/renderer_host.rs:126) — deprecated
    도입 버전 확인. 0.x 유지 문구가 정책 문서에 명시돼 있으므로(1.0에 제거
    예정) 이번 사이클은 제거하지 않고 정책 문서 문단과 상태만 정합 확인.
  - tauri/rn 레거시 `subscribeEvent` 오버로드 2건 — 도입 릴리즈 확인 후
    요건 충족 시 제거, 미충족 시 이번 사이클 유지.
- **dead_code 4건 제거** — `js_postcard_codec_supported`
  (rkyv_support.rs:14), `WireFieldKind`(rkyv_fields.rs:13,32),
  `EventState::new()`(events_state.rs:15), `surface_destroyed`
  (renderer_host.rs:189). 제거 전 실제 미사용 재확인 (grep + clippy).
- **`__RUstra_doc_` 죽은 상수** — macro_command.rs:108-109,182의
  `#[allow(dead_code)]` 상수 생성 중단 (doc 전달은 builder_commands.rs 경로로
  이미 달성됨). 매크로 생성 코드라 wire round-trip 게이트로 재검증.
- **"후속" 라벨 문구 정리** — 구현 완료된 것들(ffi_sync_entries.rs:76 등)의
  라벨을 완료 서술로 정리. 열린 것(rkyv-engine-surface.ts:146 P0-2)은 유지.
- changeset: 제거 표면에 따라 `@rustra/tauri`/`@rustra/react-native` minor
  (pre-1.0 폐기 규칙 — versioning-policy와 정합).

## 검증 게이트

- 트랙마다: 대상 패키지 `bun test` → 손대는 영역에 따라 `cargo test -p` +
  `cargo clippy --workspace -- -D warnings` + `cargo fmt --check` →
  `bun run lint` → `bun run test:docs`.
- 트랙 4 완료 후: `bun run test:compat` (node-loop 실런타임).
- 최종: `bun run test:onboarding` + 적대적 재검증(docs-gate 드리프트 주입 →
  red 확인 → 원복; 검증 4계율).
- lefthook prettier 재스테이징 필요 시 amend 관례.

## 커밋 순서 (트랙별 그룹)

1. `docs(research,plans): readiness 리서치 + 설계 문서`
2. `docs(policy): pre-1.0 공개 API breaking을 마이그레이션 노트와 함께 마이너로 허용`
3. `feat(testing): 계약 게이트 필드 수준 강화`
4. `feat(react): useSuspenseCommand 캐시/무효화 1차`
5. `feat(types,node): withRetry + NDJSON 실패 라인 보존 + 응답 셰이프 경고`
6. `docs: thiserror 에러 매핑 가이드 + 정직성 정정 4건 (CHANGELOG 0.6, ko 신설, gate fail 전환)`
7. `refactor: 코드 위생 — dead_code 제거 + 죽은 상수 중단 + 라벨 정리`
8. `chore(changesets): readiness 트랙 changeset 적립`

## 명시적 범위 밖

- 브랜치 통합(feat/tauri-channel-adapter-work 등) — 사용자 결정 보류 유지
- 레거시 제거 — 별도 진행 중
- 로컬 `changeset version` 실행 (Version PR 재생성) — 사용자 승인 시점에만
- 증거 격상(실기기/Windows host) — 1.0 트랙
- Suspense 진화 정책(LRU), Electron 어댑터, WASM — 0.8
