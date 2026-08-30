# 병렬 3트랙 (DX / Perf / Events) + 버전업 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** DX 감사 HIGH 결함 제거 + perf 5트랙 스펙 이행 + Node/Bun 이벤트 표면 완결을 3워크트리 병렬로 착지하고, changeset으로 버전업까지 진행.

**Architecture:** 브랜치별 파일 소유권을 엄격 분리하고(겹치는 node/tauri는 함수 영역 분리) 머지 순서를 Perf→DX→Events로 고정해 충돌을 라인 수준으로 억제. 각 트랙은 기존 검증 게이트(cargo test / test:ts:node / wire fixture)를 통과해야 완료.

**Tech Stack:** Rust (proc-macro, schemars, postcard/rkyv), TypeScript (Bun test), lefthook, changesets.

**설계 문서:** `docs/plans/2026-08-30-parallel-three-tracks-design.md` (커밋 f4e981af)

**계획 기준 사실 (2026-08-30 확인):**
- PR #46(version packages)은 이미 머지됨 — 모든 npm 패키지 0.5.0. testing/devtools/react는 0.4.1이지만 dep은 이미 `^0.5.0` → changeset(minor) 발행으로 발표 시 0.5.0 됨.
- 열린 PR은 Dependabot 2건(#23 napi 2→3 메이저, #20 typescript 5.9→7.0 메이저) — 본 계획과 무관, 범위 밖.
- `__RUstra_doc_` 죽은 코드는 `crates/rustra-macros/src/lib.rs:204-207`.
- 이벤트 코드젠(`generateEventsTs`)과 Tauri/RN `subscribeEvent`, Rust `emit`/`set_event_sink`/`event_bus` 폴링은 이미 존재. **갭은 Node/Bun `subscribeEvent`와 코드젠→호스트 연결 타입 정합.**
- Node는 `node-loop.ts`에 `__drainEvents` 특수 명령 폴링이 존재(transport.drainEvents()).
- Bun은 FFI 기반 — 폴링 루프로 subscribeEvent를 구현해야 함.

---

## 조율 레이어 (메인 세션)

### Task 0: 워크트리 3개 생성 + 에이전트 배치

**Step 1:** 워크트리 생성 (각각 신규 브랜치):

```bash
git worktree add .claude/worktrees/perf -b feat/perf-five-tracks
git worktree add .claude/worktrees/dx -b feat/dx-hardening
git worktree add .claude/worktrees/events -b feat/event-surface
```

**Step 2:** 각 워크트리에서 `bun install` (lockfile 정합).

**Step 3:** 3개 배경 에이전트를 1메시지에 병렬 발송. 각 에이전트 프롬프트에 다음을 포함:
- 소유 파일 목록 (설계 문서의 표) + "소유 파일 외 수정 금지, 경계 밖 항목은 SKIP 보고"
- 트랙 게이트(아래) 전부 통과해야 완료
- 커밋 관례 `feat(dx):`/`perf(x):`/`feat(events):`, lefthook prettier 후 amend 필수
- 벤치는 세션 조건(로드 평균)을 영수증에 기재
- 완료 시 docs/prs/ 아래에 트랙 리포트 작성

**Step 4:** 메인 세션은 에이전트 완료 통지를 받으면 적대적 재검증 후 머지 순서 실행.

### Task M: 머지 + 버전업 + 검증 (메인 세션)

**Step 1:** `feat/perf-five-tracks` → main 머지 (crates 소유, 첫 번째).

**Step 2:** `feat/dx-hardening` → main 머지.

**Step 3:** `feat/event-surface` rebase onto main → 충돌은 node/tauri index.ts 함수 영역 기준 해소 → 머지.

**Step 4:** 3트랙 changeset 작성 — **`@rustra/types`는 minor** (testing/devtools/react 0.4.1→0.5.0 스큐 해소 + 트랙 T generation 계약은 신규 API). 나머지는 변경 성격에 맞게 minor/patch:

```markdown
---
'@rustra/types': minor
'@rustra/testing': minor
'@rustra/devtools': minor
'@rustra/react': minor
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
---
```

(rustra crates.io 크레이트는 0.4.0 — Perf가 crates를 건드리므로 minor changeset 추가)

**Step 5:** 버전업 통합 — options:
- (a) changeset push → changesets/action이 Version Packages PR 갱신/생성 (기존 관례)
- (b) 즉시 버전 확정이 필요하면 `changeset version` 로컬 실행 후 main에 커밋
- 기본은 (a). PR 번호는 새로 발급되지만 사용자 목표("열린 PR에 통합")는 "모든 작업이 하나의 버전 PR로 통합"으로 충족.

**Step 6:** 통합 게이트: `cargo test`, `bun run test:ts:node`, wire round-trip 게이트, `rustra doctor` 스모크.

**Step 7:** 사용자 최종 승인 후 push/발행.

---

## 트랙 1: DX (`feat/dx-hardening`, 워크트리 `.claude/worktrees/dx`)

**소유:** `packages/cli/**`, `docs/**`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `packages/types/src/errors.ts`(+tests), `crates/rustra-macros/src/lib.rs`(doc 전달 부분만), `crates/rustra/src/codegen.rs`(unknown 폴백 부분만)

⚠️ `crates/` 침범 주의: DX 트랙은 **`crates/rustra-macros/src/lib.rs:204-207`와 `crates/rustra/src/codegen.rs`의 unknown 폴백 3곳만** 수정 가능(감사 항목). 그 외 crates 수정 시 이슈로 남기고 SKIP.

### Task 1.1: CLI arg-parser 통일

**Files:**
- Create: `packages/cli/src/arg-parser.ts` + `arg-parser.test.ts`
- Modify: `index.ts`, `dev.ts`, `doctor.ts`

**Step 1: 실패 테스트** — `--help`가 exit 2 + 도움말, `--flag=value`, 알 수 없는 플래그는 "Unknown option: X" + fix 안내:

```typescript
import { describe, test, expect } from "bun:test";
import { parseArgs } from "./arg-parser.js";

describe("parseArgs", () => {
  test("rejects unknown flags with fix hint", () => {
    expect(() => parseArgs(["--configg", "x"], { known: ["config"] }))
      .toThrow(/Unknown option: --configg/);
  });
  test("supports --flag=value", () => {
    expect(parseArgs(["--config=x"], { known: ["config"] })).toEqual({ config: "x" });
  });
});
```

**Step 2:** `bun test packages/cli/src/arg-parser.test.ts` → FAIL 확인.

**Step 3:** 구현 — 단일 파서(known 플래그 화이트리스트, `--flag=value` 지원, `--help` 감지, exit 2 사용법 오류, 에러에 fix 안내 포함). 4 호출부(index/dev/doctor)를 이 파서로 교체.

**Step 4:** `bun test packages/cli/` → PASS. `node packages/cli/dist/index.js codegen --help` 스모크로 도움말 출력 확인.

**Step 5:** 커밋 `feat(cli): 통합 arg-parser — --help/exit 2/--flag=value 균등 지원`

### Task 1.2: CLI 인체공학

**Files:**
- Modify: `packages/cli/src/index.ts:249-272` (codegen 빌드 스피너), `:363-395` (init), `packages/cli/src/init-template.ts:19-27` (.gitignore/tsconfig), `packages/cli/src/config.ts:35-169` (오타키 loud-fail), `packages/cli/src/index.ts:410-428` (help 보강)

**Step 1: 실패 테스트** — `config.test.ts`에: 알 수 없는 키(`"reactNativ"`) → 에러 + 알려진 키 중 closest 제안(edit-distance 재사용 가능하면 testing의 제안 패턴 참고).

**Step 2:** FAIL 확인.

**Step 3:** 구현 — (a) config unknown 키 loud-fail+제안. (b) init: 기존 파일 존재 시 차단 + `--force` 플래그로 재생성. (c) 스캐폴드에 `.gitignore`(target/node_modules/generated/.rustra-generated.json) + `tsconfig.json` 추가. (d) codegen cargo 빌드 스피너+경과 출력. (e) help에 `dev --config` 문서화.

**Step 4:** `bun test packages/cli/` + 스모크: 임시 dir에서 `rustra init` 2회 실행 → 2회째는 차단 확인, `--force`로 통과.

**Step 5:** 커밋 `feat(cli): init 덮어쓰기 차단·config 오타 loud-fail·빌드 스피너·스캐폴드 완비`

### Task 1.3: 에러 품질 (errors.ts)

**Files:**
- Modify: `packages/types/src/errors.ts:13-18`(생성자 cause), `:61-75`(normalize 보존)
- Test: `packages/types/src/errors.test.ts`

**Step 1: 실패 테스트:**

```typescript
test("preserves original error as cause", () => {
  const original = new Error("boom");
  const norm = normalizeRustraError({ code: "command.failed", message: "wrapped" }, original);
  expect(norm.cause).toBe(original);
  expect(norm.stack).toBeDefined();
});
test("TimeoutError/CancelledError subclasses", () => {
  const e = normalizeRustraError({ code: "command.timeout", message: "" });
  expect(e).toBeInstanceOf(TimeoutError);
  expect(e).toBeInstanceOf(RustraError);
});
```

**Step 2:** FAIL 확인 → 구현(cause 옵션, Timeout/Cancelled 서브클래스, 기존 코드 매핑 유지) → PASS.

**Step 3:** 커밋 `feat(types): 에러 cause 보존 + Timeout/Cancelled 서브클래스`

### Task 1.4: RUSTRA_DEBUG 와이어 덤프

**Files:**
- Modify: `packages/types/src/rkyv-engine.ts`(덤프 훅), 신규 `packages/types/src/debug.ts`
- Test: `packages/types/src/debug.test.ts`

**Step 1: 실패 테스트** — `RUSTRA_DEBUG=wire` 설정 시 invoke가 hex+파싱 결과를 stderr로 덤프. env 파싱 순수함수(`shouldDumpWire()`)로 분리해 테스트.

**Step 2:** FAIL → 구현 — `debug.ts`: `shouldDumpWire()`, `dumpWire(direction, bytes)`; rkyv-engine의 postcard/rkyv 경로에 훅. stderr(파이프 시 폐기 안전).

**Step 3:** `bun test packages/types/` → PASS, 커밋 `feat(types): RUSTRA_DEBUG=wire 와이어 덤프`

### Task 1.5: 문서 HIGH 6건

**Files:** `README.md:12-13`, `docs/rust-api-guide.md:424-432`+`:559-570`, `docs/getting-started.md:621-709`, `CONTRIBUTING.md:233-245`, `CHANGELOG.md`

**Step 1:** README init 예제를 실제 동작 형태로 수정(예: `bunx rustra init my-app`), 문서 예제를 examples/calculator/generated 실제 코드와 대조해 교정. divide 시그니처 수정. CONTRIBUTING 릴리스 섹션을 lefthook+changesets 현행 프로세스로 재작성. CHANGELOG에 0.3→0.5 요약 추가.
**Step 2:** 스모크: 문서의 init/codegen 명령을 임시 dir에서 실제 실행해 성공 확인.
**Step 3:** 커밋 `docs: 실행 실패 예제 6건 교정 + CHANGELOG 0.3→0.5 요약`

### Task 1.6: Rust 저작면 HIGH

**Files:**
- Modify: `crates/rustra/src/codegen.rs:138,169,174` (unknown 폴백 loud), `crates/rustra-macros/src/lib.rs:204-207` (`__RUstra_doc_` → JSDoc 전달)

**Step 1:** 실패 테스트 — 코드젠 테스트에서 매핑 불가 타입이 unknown 폴백 대신 경고(타입명+명령명 포함)를 내는지 검증. 매크로 테스트에서 `__RUstra_doc_` 상수가 TS JSDoc으로 전달되는지 검증.
**Step 2:** FAIL → 구현: unknown 폴백 시 `eprintln!` 대신 수집형 진단(코드젠 결과에 warnings 배열) — CLI가 이를 출력. `__RUstra_doc_`는 package_codegen.rs:225-231의 TS JSDoc 생성에서 구조체 doc과 동일하게 소비.
**Step 3:** `cargo test -p rustra` + `cargo test -p rustra-macros` → PASS.
**Step 4:** 커밋 `feat(codegen): unknown 폴백 경고 + fn doc → TS JSDoc 전달`

### 트랙 1 게이트 (전부 통과 후 완료)

- `bun test packages/cli packages/types`
- `cargo test -p rustra -p rustra-macros`
- CLI 스모크: `doctor --format json` / `codegen --help` / init 2회 차단
- `bun run test:ts:node` (전체 TS 게이트)

---

## 트랙 2: Perf (`feat/perf-five-tracks`, 워크트리 `.claude/worktrees/perf`)

**소유:** `crates/rustra/**` (DX가 건드리는 2파일 제외), `packages/types/src/rkyv-engine.ts`·`complex-codec.ts`·`debug.ts` 제외, `packages/bun/**`, `packages/node/src/node-loop.ts`, `packages/tauri/src/index.ts`(dispatch)·`tauri_support.rs`, `packages/react-native/native/cpp/**`

**계약:** 기존 4개 plan 문서가 상세 계획이므로 그대로 실행 (`docs/plans/2026-08-29-perf-core-codec-tracks.md` 등 4건). 요약:

- **Track A/B (core codec):** 스키마 사전컴파일 → serde 어댑터로 Value 트리 3왕복 제거. 게이트: addNumbers core dispatch 2.9µs→≤1µs, wire fixture byte-exact.
- **Track Bun:** safe-integer fast-path + raw capability + slice 제거. 게이트: 2.27µs→1µs 내외, 바이트 동일성.
- **Track Node:** 바이너리 프레이밍+Buffer 누적. 게이트: 16.9µs→3-6µs, NDJSON 호환 폴백 유지.
- **Track Tauri:** 측정 정합화 먼저(Rust Instant 차감+배치 확대) — 실성능 영수증 필수. 이후 dispatch_batch는 실측 후 결정.
- **Track RN:** cachedProp 정적 테이블화 + async byId 진입. F3/Android 실측은 있으면 추가.
- **Track T:** generation 계약 + 동적 postcard 옵트인 (plan 문서 `2026-08-29-perf-dynamic-tier-track.md`).

**각 하위 트랙마다:** 실패 벤치/테스트 먼저 → 구현 → 게이트 통과 → 커밋 `perf(x): ...` → 벤치 영수증은 `docs/benchmark-receipts/`에 세션 조건 포함 기록.

### 트랙 2 게이트

- PINNED wire fixtures byte-exact (`cargo test` + `bun run test:ts:node` + C++ codec tests)
- 스펙의 정량 목표 달성 + 영수증 기록
- `cargo test` 전체 + `bun run test:ts:node` 전체

---

## 트랙 3: Events (`feat/event-surface`, 워크트리 `.claude/worktrees/events`)

**소유:** `crates/rustra-macros`+코드젠(generateEventsTs 계열), `packages/node/src`(`subscribeEvent` 신규), `packages/bun/src`(subscribeEvent 신규), `packages/tauri/src/tauri-events.ts`, `docs/compatibility-matrix.md`, 예제 스키마의 events 섹션.

⚠️ Perf가 node-loop.ts(transport)와 tauri dispatch를 건드림 → **Events는 Perf 머지 후 rebase하고 시작**. 시작 전 자기 base에서 Rust/코드젠 부분만 진행 가능.

**참고 지상진실:** 이미 존재하는 것 — Rust `Package::emit`/`set_event_sink`/`event_bus` (`crates/rustra/src/package_events.rs`), 코드젠 `generateEventsTs`(RustraEventName/RustraEventPayloads/SubscribeFn, `packages/cli/src/generate-surface.ts:42-84`), Tauri `subscribeEvent`(`packages/tauri/src/tauri-events.ts`), RN `subscribeEvent`(`packages/react-native/src/react-native-events.ts`). 갭 = Node/Bun.

### Task 3.1: Bun subscribeEvent (FFI 폴링 래퍼)

**Files:**
- Create: `packages/bun/src/bun-events.ts` + `bun-events.test.ts`
- Modify: `packages/bun/src/index.ts` (export)

**Step 1: 실패 테스트** — mock FFI(`takePendingEvents` 폴링)로: (a) emit→구독 콜백 수신, (b) unsubscribe 후 수신 안 함, (set_event_sink 싱크가 설치되면 버스가 비고 이중 수신 없음 주석 명시).
**Step 2:** FAIL → 구현: `take_pending_events` FFI 바인딩 폴링(setInterval/setTimeout 백오프), `subscribeEvent(name, cb) → () => void`. 시그니처는 RN `subscribeEvent(name, cb) → unsubscribe`와 동일.
**Step 3:** `bun test packages/bun/` → PASS, 커밋 `feat(bun): subscribeEvent — 이벤트 버스 폴링 래퍼`

### Task 3.2: Node subscribeEvent

**Files:**
- Create: `packages/node/src/node-events.ts` + 테스트
- Modify: `packages/node/src/index.ts` export, `node-loop.ts`에 drainEvents가 이미 있으므로 이를 래핑

**Step 1: 실패 테스트** — 구독 시 `__drainEvents` 폴링(transport.drainEvents)으로 전환하는 콜백 어댑터. unsubscribe 시 폴링 중지, 구독자 0이면 폴링 종료. 여러 구독자가 한 폴링 루프 공유.
**Step 2:** FAIL→구현→PASS, 커밋 `feat(node): subscribeEvent — drainEvents 폴링 콜백 어댑터`

### Task 3.3: 코드젠→호스트 연결 정합

**Files:** `packages/cli/src/generate-surface.ts` (필요 시 SubscribeFn 문서 갱신), `packages/tauri/src/tauri-events.ts` (시그니처 확인)
**Step 1:** 4호스트(node/bun/tauri/RN)의 subscribeEvent 시그니처가 `(<N extends RustraEventName>(name, cb) => unsubscribe)`로 일치하는지 테스트(타입 테스트)로 고정. 불일치 시 수렴.
**Step 4:** 커밋 `feat(events): 4호스트 subscribeEvent 시그니처 정합`

### Task 3.4: compatibility-matrix 갱신

**Files:** `docs/compatibility-matrix.md:13-16`
**Step 1:** Node/Bun subscribeEvent ❌→✅ 갱신 + 각 호스트 전달 경로(push sink vs polling) 1줄 주석.
**Step 2:** 커밋 `docs: 이벤트 호스트 패리티 반영 — Node/Bun subscribeEvent ✅`

### 트랙 3 게이트

- `bun test packages/node packages/bun packages/tauri`
- 코드젠 round-trip + diff 게이트
- `bun run test:ts:rebase` 후 최종 게이트는 머지 시 메인에서
