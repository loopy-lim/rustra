# Production readiness 트랙 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** readiness 갭 6트랙을 한 브랜치에 순차 착지 — 버전 정책 minor-only 개정, 계약 게이트 필드 수준 강화, React Suspense 캐시, 에러/디버깅 품질 4건, 문서 정직성 4건, 코드 위생.

**Architecture:** 워크트리 `.worktrees/readiness` + 브랜치 `feat/readiness-tracks`, 베이스 `changeset-release/main` (bd72610b, 0.7.0 version 커밋). 트랙별 커밋 그룹 → 전면 게이트 → `changeset-release/main` 로컬 머지 → 푸시. **로컬 `changeset version` 실행 없음** — changeset 적립만 하고 다음 version 실행에서 minor로 귀결. 러스트 계약 게이트 구조상 schema.json은 명령의 유일 진실원이고 생성물(contract.ts의 `GENERATED_CONTRACT_HASH`, commands.ts의 필드 키 상수)이 그 정합 증거다.

**Tech Stack:** TypeScript (bun test + node:test), Rust (cargo test/clippy), changesets, React (renderToString 기반 SSR 테스트 — 기존 관례).

**설계 문서:** `docs/plans/2026-09-03-readiness-tracks-design.md`

**워크트리 경로 주의:** 이 계획의 모든 경로는 `/Users/loopy/dev/ll3/rustra-bridge/.worktrees/readiness/` 안에서 실행한다. 메인 디렉터리에서는 레거시 제거 작업이 진행 중이므로 절대 건드리지 않는다.

---

## 조사로 확정된 사실 (계획의 앵커)

1. **버전 정책 표**: `docs/versioning-policy.md:20-21` (+ko:17-18) 공개 Rust/TS API 행만 "메이저 버전." 단수 — pre-1.0 경로 부재. 나머지 4행은 "메이저. Pre-1.0: 마이너+노트" 구문 보유.
2. **계약 게이트**: `packages/testing/src/contract-gate.ts:10-20` — 이름 집합 비교만. `GeneratedCommand`(`packages/types/src/global-state.ts:60-63`)은 필드 키를 노출하지 않는다(클로저 갇음). 코드젠 필드 키 상수는 `commands.ts`의 `createGeneratedFields2(id, 'name', "a", "b", 'name')` 호출 인자에 존재.
3. **contract hash**: `contract.ts`의 `GENERATED_CONTRACT_HASH` = sha256(schema.json 원문) (`packages/cli/src/generate-surface.ts:156` `generateContractTs`). schema.json 자체엔 hash 필드가 없으므로 게이트는 **"schema.json을 다시 해시해 contract.ts의 상수와 대조"** 방식이 된다 — 이원화 없음(같은 입력 함수).
4. **deprecated 도입 시점**: tauri/rn 레거시 `subscribeEvent` 오버로드 2건 모두 `69a5a2ae` (2026-08-30) 착지 → 0.6.0에 발행됨(태그 `@rustra/tauri@0.6.0` 등이 이 커밋 포함). **현재 대기 발행이 0.7.0이면 "최소 1 마이너 유지" 요건 충족 → 0.7.0에서 제거 가능.** 단 제거는 폐기 절차상 CHANGELOG 문서화 필수. `RendererHost`는 정책 문서가 "0.x 사이클 끝까지 유지" 명시 — 이번 사이클 건드리지 않는다.
5. **withRetry 부재**: `packages/types/src/index.ts`에 grep 0건. `isRetryableCode`(errors.ts:121)만 존재.
6. **NDJSON 폐기**: `packages/node/src/node-loop.ts:274-276` `catch { continue; }`, `:287` `proc.stderr.on('data', () => {})`.
7. **docs-gate 미결**: `scripts/docs-gate.mjs:63`("후속 판단 사항" 주석), `:231-238`(마커 0 통과 분기). 현재 마커 4개가 이미 채택돼 있으므로 "마커 0" 분기는 이론 경로가 됐고, fail 전환의 실제 의미는 **드리프트 리전 발견 시 exit 1 이미 존재** — 미결 부분은 strip 과잉 트레이드오프와 마커 0 분기. **소처분 = 마커 0을 fail로 바꾸는 것이 아니라** 주석의 미결 상태를 "마커 0 허용 유지(점진 채택 정책)"로 확정 기록 + gate 테스트로 고정.
8. **over-claim**: `docs/rust-api-guide.md:140`(+ko:138) — `#[diagnostic::on_unimplemented]` 사용처가 코드에 0건(grep 확인).
9. **루트 CHANGELOG**: 0.5 요약까지 존재, 0.6 부재. 패키지 0.6.0 발행 현실.
10. **ko 부재**: `docs/compatibility-contract.md`에 `.ko.md` 없음 (유일한 en-only 가이드).
11. **dead_code 4건 + 죽은 상수**: `rkyv_support.rs:14` `js_postcard_codec_supported`, `rkyv_fields.rs:13,32` `WireFieldKind`, `events_state.rs:15` `EventState::new()`, `renderer_host.rs:189` `surface_destroyed`. `__RUstra_doc_` 상수는 **죽지 않았다** — macro_register.rs:79 / macro_build.rs:83이 `.command_doc(#meta_ident, #doc_ident)`으로 소비한다 (리서치의 "죽은 상수" 판정은 오독). 상수 자체의 `#[allow(dead_code)]`(macro_command.rs:184-186)는 빌더 체인이 읽기 전까지 컴파일러가 도달 못 하는 구조적 불가피 — **건드리지 않는다.**
12. **"후속" 라벨 완료분**: `crates/rustra/src/ffi_sync_entries.rs:76`(caller-buffer — 구현+활성 테스트 존재).

---

### Task 0: 워크트리 베이스라인

**Files:** 없음 (검증만)

**Step 1:** 워크트리 확인 — `.worktrees/readiness`에서 브랜치가 `feat/readiness-tracks`, HEAD가 `bd72610b`인지 확인 (이미 생성됨).

**Step 2: 의존성 설치 + 베이스라인**

```bash
cd /Users/loopy/dev/ll3/rustra-bridge/.worktrees/readiness
bun install --frozen-lockfile
bun test packages/testing packages/types packages/react packages/node
bun run test:docs
```

Expected: 전부 PASS. red가 있으면 착지 전에 먼저 보고.

---

### Task 1: 리서치·설계 문서 커밋

**Files:**
- Add: `docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md` (메인 디렉터리에 이미 존재 — 워크트리로 복사)
- Add: `docs/plans/2026-09-03-readiness-tracks-design.md` (동일)
- Add: `docs/plans/2026-09-03-readiness-tracks.md` (이 파일)

**Step 1:** 메인 디렉터리의 3개 문서를 워크트리로 복사.

**Step 2: 커밋**

```bash
git add docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md docs/plans/2026-09-03-readiness-tracks-design.md docs/plans/2026-09-03-readiness-tracks.md
git commit -m "docs(research,plans): readiness 갭 리서치 + 트랙 설계·계획"
```

---

### Task 2: 버전 정책 minor-only 개정

**Files:**
- Modify: `docs/versioning-policy.md:20-21, 76-89`
- Modify: `docs/versioning-policy.ko.md:17-18, 72-83`

**Step 1: 표 행 수정 (en)**

`docs/versioning-policy.md` 호환성 보장 범위 표의 두 행:

- 공개 Rust API 행의 Breaking change 요구 조건: `Major version.` → `Major version. Pre-1.0: a minor with explicit migration notes.`
- 공개 TypeScript API 행: 동일 문구.

**Step 2: "Release numbering" 절에 원칙 명문화 (en)**

기존 마지막 문단(86-88행 "Under the pre-1.0 rules above...")을 다음으로 교체·확장:

```markdown
Until 1.0, a breaking change on any guaranteed surface above — including the
public Rust and TypeScript APIs — ships as a minor version with explicit
migration notes (documented in CHANGELOG and, where consumers must act, in
`docs/migrations/<from>-to-<to>.md`). From 1.0 this allowance is gone: such
changes require a major version. The project stays on minor releases until
then; majors are not issued pre-1.0.
```

**Step 3: ko 미러 동일 수정** — `.ko.md:17-18` 두 행("메이저 버전." → "메이저 버전. pre-1.0에서는 마이그레이션 노트를 동반한 마이너.") + 릴리즈 번호 체계 절末 동일 원칙 문단(한국어로).

**Step 4: 게이트 + 커밋**

```bash
bun run test:docs
git add docs/versioning-policy.md docs/versioning-policy.ko.md
git commit -m "docs(policy): pre-1.0 공개 API breaking도 마이그레이션 노트와 함께 마이너로 허용"
```

---

### Task 3: 계약 게이트 필드 수준 강화

**Files:**
- Modify: `packages/testing/src/contract-gate.ts`
- Test: `packages/testing/src/index.test.ts`
- Reference: `examples/calculator/generated/commands.ts`, `examples/calculator/generated/contract.ts`

**설계 결정 (조사 확정):** `GeneratedCommand`는 필드 키를 런타임에 노출하지 않으므로, 게이트는 **commands.ts 소스 텍스트에서 `createGeneratedFieldsN(id, 'name', "f1", "f2", ...)` 인자를 정규식으로 추출**해 schema.json의 `inputSchema.required`+`properties`와 대조한다. 소스 텍스트가 필요하므로 신규 API는 파일 내용을 받는 형태가 된다:

```ts
export type ContractFieldDrift = {
  command: string;
  kind: 'field_missing_in_schema' | 'field_missing_in_client' | 'field_order_mismatch';
  detail: string;
};

/** 생성 commands.ts 소스와 schema.json의 필드 수준 정합성 — 추가/삭제/순서 변경 감지. */
export function assertContractFieldsCurrent(
  schema: { commands: Array<{ name: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }> },
  generatedCommandsSource: string,
): { drift: ContractFieldDrift[] }
```

정규식: `createGeneratedFields(?:1|2|3)\s*\(\s*(\d+)\s*,\s*['"]([^'"]+)['"]((?:\s*,\s*(?:"([^"]+)"|'([^']+)'))+?)\s*,\s*['"]` — 필드 키는 3번째~N번째 문자열 인자, 마지막은 functionName이므로 **마지막 문자열 1개는 필드에서 제외**. (정확 패턴은 생성물 실측 후 확정 — `commands.ts:13` 실측: `createGeneratedFields2<...>(1, 'addNumbers', "a", "b", 'addNumbers')`.)

**Step 1: 실패하는 테스트 작성** — `index.test.ts`에 추가:

```ts
// 필드 정합 — drift 없음
{
  const schema = { commands: [{ name: 'add', inputSchema: { required: ['a', 'b'], properties: { a: {}, b: {} } } }] };
  const src = `export const add = createGeneratedFields2(1, 'add', "a", "b", 'add');`;
  const { drift } = assertContractFieldsCurrent(schema, src);
  assert.deepEqual(drift, []);
}
// 클라이언트 필드 삭제 감지 (스키마엔 a,b — 생성엔 a만)
// 순서 불일치 감지 ("a","b" vs schema required ["b","a"])
// 스키마에만 있는 필드 감지
```

Run: `bun test packages/testing` → FAIL (함수 미존재).

**Step 2: 구현** — `contract-gate.ts`에 위 함수 추가. 파싱 실패(생성물에 패턴이 하나도 없음)는 빈 결과가 아니라 drift 1건(`kind: 'field_missing_in_client'`, detail에 원인)으로 보고 — 조용한 통과 금지(검증 4계율).

**Step 3: `expectContractFieldsCurrent` 래퍼도 추가** — `expectContractCurrent` 동형(throw 기반, 드리프트 메시지 조립).

**Step 4: 실제 생성물 스모크** — calculator 생성물로 검증:

```bash
bun -e "import {readFileSync} from 'fs'; const {assertContractFieldsCurrent} = await import('./packages/testing/src/index.ts'); const schema = JSON.parse(readFileSync('examples/calculator/generated/schema.json','utf8')); const src = readFileSync('examples/calculator/generated/commands.ts','utf8'); const {drift} = assertContractFieldsCurrent(schema, src); console.log('drift:', drift);"
```

Expected: `drift: []`.

**Step 5: 테스트 PASS + 커밋**

```bash
bun test packages/testing
git add packages/testing/src/contract-gate.ts packages/testing/src/index.test.ts
git commit -m "feat(testing): 계약 게이트 필드 수준 강화 — 생성 commands.ts 필드 키↔schema 대조"
```

(changeset은 Task 10에서 일괄.)

---

### Task 4: contract hash 대조 게이트 (contract.ts 연동)

**Files:**
- Modify: `packages/testing/src/contract-gate.ts` (같은 트랙 — Task 3에 이어서)
- Test: `packages/testing/src/index.test.ts`

**설계:** `GENERATED_CONTRACT_HASH = sha256(schema.json 원문)` 이므로 게이트가 할 일은 단순 대조다:

```ts
export function assertContractHashCurrent(
  schemaJsonContent: string,          // schema.json 파일 원문
  contractTsContent: string,          // contract.ts 파일 원문
): void  // hash 불일치/추출 실패 시 throw
```

해시 재계산은 의존 추가 없이 WebCrypto 대신 nodecrypto(`node:crypto` createHash — testing 패키지는 node 런타임 전제, 기존 테스트도 node:assert 사용)로.

**Step 1: 실패 테스트** — 일치 시 통과, 1자 불일치 시 throw, `GENERATED_CONTRACT_HASH` 상수 미발견 시 throw.
**Step 2: 구현 + PASS.**
**Step 3: 실제 생성물 스모크** (calculator contract.ts vs schema.json) — Expected: 통과.
**Step 4: 커밋** `feat(testing): contract hash 대조 게이트 — schema.json↔contract.ts 정합`.

---

### Task 5: React useSuspenseCommand 1차

**Files:**
- Create: `packages/react/src/useSuspenseCommand.ts`
- Modify: `packages/react/src/index.ts` (export)
- Test: `packages/react/src/index.test.ts`

**설계:** promise-throwing 패턴(React 18 `use` + 19 Suspense 양립). 모듈 레벨 `Map<string, { promise, status, value?, error? }>` 캐시, 키 = `` `${commandName}::${inputKey(input) ?? ''}` `` (input-key.ts 재사용 — bigint 안전). `invalidateCommands(commandName?)` — 인자 있으면 해당 명령 키만, 없으면 전체.

```ts
export function useSuspenseCommand<I, O>(
  commandFn: CommandFn<I, O> | VoidCommandFn<O>,
  input?: I,
): O;  // Suspense 하에서만 호출 — 미해결이면 promise를 던진다
```

- promise는 1회 실행 보장 — throw된 promise가 settle하면 캐시 갱신.
- 컴포넌트 밖에서도 쓰는 무효화: `invalidateCommands()` export.
- error가 settle된 경우 throw된 그 에러를 다시 던진다(error boundary 계약).
- LRU 등 진화 정책 없음 (YAGNI).

**Step 1: 실패 테스트** — 기존 관례(node:test + renderToString)로:
1. 정상 렌더 — 캐시 hit 후 데이터 반환은 SSR에서 promise가 resolve되지 않으므로, 캐시 사전 워밍 방식으로 검증: `useSuspenseCommand` 내부 캐시에 접근 가능한 헬퍼(`__primeSuspenseCacheForTests` 또는 invalidate 후 수동 set)를 노출하지 말고, 대신 **비동기 테스트**: 먼저 `engine.invoke`가 resolve될 때까지 기다렸다가(모듈 캐시는 명령 실행 시 채워지므로) 렌더. 실제 패턴은 구현 시 `renderToString`이 promise를 그대로 렌더링 못 하는 점을 감안해 — **`use(Promise)`는 node:test SSR에서 어려우므로 로직을 훅에서 분리**해 순수 함수(`resolveSuspenseEntry` 캐시 상태머신)로 테스트하고, 훅은 얇게. (이 분리가 기존 테스트 관례와 가장 잘 맞는다.)
2. 캐시 키 분리 — 같은 명령 다른 input은 다른 엔트리.
3. `invalidateCommands('cmd')` 후 재요청 — 새 promise.
4. bigint input — 크래시 없음 (inputKey 재사용 검증).

**Step 2: 구현** — 캐시 상태머신(순수) + 훅(얇게).
**Step 3: PASS + 커밋** `feat(react): useSuspenseCommand 캐시/무효화 1차`.

---

### Task 6: withRetry (types)

**Files:**
- Create: `packages/types/src/retry.ts`
- Modify: `packages/types/src/index.ts` (`export * from './retry.js'` — errors.js 옆)
- Test: `packages/types/src/index.test.ts`

**설계:**

```ts
export type RetryOptions = {
  retries?: number;            // 기본 2 (총 시도 3회)
  baseDelayMs?: number;        // 기본 100 — delay = baseDelayMs * 2^attempt
  signal?: AbortSignal;
  retryIf?: (error: RustraCommandError, attempt: number) => boolean;  // 기본 isRetryableCode(error.code)
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions,
): Promise<T>;
```

- 마지막 에러를 그대로 재던짐(정규화는 호출자 책임 유지 — 관례 존중).
- signal abort 시 즉시 `CancelledError` 승격(기존 errors.ts 관례).
- sleep은 테스트 가능하게 타이머 주입 없이 — vi/bun 타이머 대신 `retries: 0` 테스트 + 짧은 delay(1ms) 실대기.

**Step 1: 실패 테스트** — ① 재시도 성공(1회 실패 후 성공, 반환값 확인), ② retries 소진 시 마지막 에러, ③ non-retryable code는 즉시 실패, ④ retryIf 커스텀, ⑤ signal abort, ⑥ bigint/에러 원본 보존.
**Step 2: 구현 + PASS.**
**Step 3: 커밋** `feat(types): withRetry — retryable 소비 유틸`.

---

### Task 7: NDJSON 실패 라인·stderr 보존 (node)

**Files:**
- Modify: `packages/node/src/node-loop.ts:270-287`
- Test: `packages/node` 기존 테스트 파일 관례 확인 후 추가 (`packages/node/src/*.test.ts` 존재 확인)

**설계:**
- `catch { continue; }` → `catch { onUnparsedLine(line); continue; }`. `onUnparsedLine`: `isRustraDebugEnabled()`면 `debugRustra({ kind: 'ndjson.unparsed', line })` + stderr warn 1회성, 아니면 **최근 N(=32)줄 링버퍼** 보존 — 프로세스 exit 시(기존 exit 핸들러 :289) 대기 중 요청이 있으면 보존분을 에러 메시지에 첨부.
- `proc.stderr.on('data', () => {})` → debug 모드에서 수집해 exit 시 첨부, 비debug는 기존대로 폐기(성능 무영향).
- `debugRustra`/`isRustraDebugEnabled`는 `@rustra/types`에서 import (types가 이미 의존성).

**Step 1: 실패 테스트** — node-loop 단위 테스트 패턴을 기존 테스트에서 확인. stdout으로 잘못된 JSON 라인 1줄 + 정상 응답을 흘려보내 ① 정상 응답은 resolve, ② debug on 시 unparsed 이벤트가 debug sink에 도달, ③ exit 시 대기 요청 에러 메시지에 최근 라인 포함.
**Step 2: 구현 + PASS.**
**Step 3: `bun run test:compat` 중 node 부분 확인.**
**Step 4: 커밋** `feat(node): NDJSON 파싱 실패 라인·stderr 보존 — RUSTRA_DEBUG 진단`.

---

### Task 8: 응답 셰이프 검증 경고 (types) + thiserror 문서

**Files:**
- Modify: `packages/types/src/json-engine.ts` (응답 처리 지점)
- Modify: `docs/rust-api-guide.md`, `docs/rust-api-guide.ko.md` (thiserror 절 신설 + on_unimplemented 정정 — Task 9와 겹치므로 문서 쪽은 Task 9에서 일괄)
- Test: `packages/types/src/index.test.ts`

**8a. 응답 셰이프 검증:**
- json-engine의 응답 파싱 후 — `json-wire.ts`의 `ok:true` 응답에서 JSON 본문이 `undefined`(빈 본문)이거나 typed 커맨드 기대와 명백히 다른 원시형(예: `"string"`이 왔는데 객체 기대)인 경우, debug 모드에서 `debugRustra({ kind: 'response.shape' })` warn.
- 정확 검증 지점과 판정 기준은 json-engine.ts:17 `createJsonEngine` 내부 읽고 확정. **동작은 경고뿐 — 예외 던지지 않음.**

**Step 1: 실패 테스트** — debug sink 주입(configureDebug) 후 이상 셰이프 응답에서 이벤트 도달.
**Step 2: 구현 + PASS.** **Step 3: 커밋** `feat(types): 응답 셰이프 검증 경고 — RUSTRA_DEBUG 버전 스큐 조기 감지`.

---

### Task 9: 문서 정직성 4건

**Files:**
- Modify: `docs/rust-api-guide.md:136-150` + `.ko.md:134-148`
- Modify: `CHANGELOG.md` (루트)
- Create: `docs/compatibility-contract.ko.md`
- Modify: `docs/README.md:39`, `docs/README.ko.md:37` (ko 링크 추가)
- Modify: `scripts/docs-gate.mjs:55-63, 228-238` + `scripts/docs-gate.test.ts`
- Modify: `docs/versioning-policy(.ko).md` — Task 4(deprecated 유지) 결과 반영은 없음(그대로) 확인만

**9a: on_unimplemented 정정** — en/ko 양쪽에서 "produces a friendly error message"/"친절한 에러 메시지를 출력합니다" 단락을 실제 상태로 교체:

```markdown
Currently, an unsatisfied trait bound produces the standard Rust E0277
diagnostic. A `#[diagnostic::on_unimplemented]`-based custom message is
planned but not implemented — do not rely on a custom error text yet.
```

**9b: 루트 CHANGELOG 0.6 요약** — Unreleased 아래에 `## 0.6.0 (2026-08)` 섹션 추가: 3-4문 요약(이벤트 표면 완결/성능 5트랙/DX·CLI/타입 패리티) + "세부는 packages/*/CHANGELOG.md 및 docs/migrations/0.5-to-0.6.md" 위임. 기존 "0.3 → 0.5 요약" 문체 따름.

**9c: compatibility-contract.ko.md 신설** — en 원문 전체 번역(ko 문서 관례 문체). `docs/README.md`와 `.ko.md`의 목록 항목에 `.ko.md` 링크 추가(다른 가이드 항목의 en|ko 병기 패턴 준용).

**9d: docs-gate 미결 소처분** —
- `scripts/docs-gate.mjs:55-63`의 "후속 판단 사항" 주석을 결정 서술로 교체: "과잉 strip 가능성은 알려진 트레이드오프로 **수용한다** — 마커 본문은 생성물 기준 byte-for-byte가 계약이며, 본문 첫 줄이 우연히 `// ──`인 파일은 docs:sync 대상으로 쓰지 않는 관례로 회피."
- `:231-238` 마커 0 분기도 결정 고정: "마커 0 허용은 점진 채택 정책 — fail 전환하지 않는다" 주석 + 동작 불변.
- `docs-gate.test.ts`에 이 두 결정을 고정하는 테스트 추가(마커 0 → exit 0 + 안내 메시지; strip 시나리오 기존 커버 확인).
- 적대적 재검증: 마커 본문 1자 수정 → `bun run test:docs` red 확인 → 원복 → green.

**커밋:** 4건을 각각 커밋 (9a `docs(guide): on_unimplemented 미구현 정정 — over-claim 제거`, 9b `docs(changelog): 루트 CHANGELOG 0.6 요약 보강`, 9c `docs(contract): compatibility-contract 한국어 미러 신설`, 9d `test(docs-gate): 미결 결정 고정 — strip 트레이드오프 수용 + 마커 0 점진 채택 유지`).

---

### Task 10: 코드 위생 — 레거시 전면 제거 (사용자 지시 확정)

**Files:**
- Modify: `crates/rustra/src/rkyv_support.rs:10-20` (`js_postcard_codec_supported` 제거)
- Modify: `crates/rustra/src/rkyv_fields.rs` (`WireFieldKind` 및 impl 제거 — 사용처 재확인 후)
- Modify: `crates/rustra/src/events_state.rs:14-17` (`new()` 제거)
- Delete: `crates/rustra/src/renderer_host.rs` 전체 (deprecated `RendererHost` 표면 — 조사로 소비처가 자체 mock 테스트 + prelude 재노출뿐임을 확인)
- Modify: `crates/rustra/src/prelude.rs:2,10-11` (RendererHost 재노출 제거 + 주석 제거)
- Delete: `crates/rustra/src/renderer_host_tests.rs` (자체 mock만 존재)
- Modify: `crates/rustra/src/lib.rs` (두 모듈 선언 제거)
- Modify: `crates/rustra/src/ffi_sync_entries.rs:76` (주석 "성능 후속" → 완료 서술)
- Modify: `docs/versioning-policy.md:47-50` + `.ko.md:43-46` ("Current status: RendererHost..." 문단 — 제거 반영으로 교체: "removed in 0.7.0, replacement = host-specific adapter boundary")
- Modify: `packages/tauri/src/tauri-events.ts:54-` + `packages/react-native/src/react-native-events.ts:51-` (레거시 오버로드 제거)

**10a: Rust dead_code + deprecated RendererHost 전면 제거 (사용자 지시 "레거시 모두 제거")**
- 조사 확정: `RendererHost`+부속 타입(HostMessage/MessageKind/RendererCapabilities/Size/SurfaceOptions/host_supports_eval)의 소비처는 `renderer_host_tests.rs`(자체 mock)와 `prelude.rs` 재노출뿐 — examples 0건. deprecated 도입이 0.6.0 이전이므로 폐기 요건("최소 1 마이너 유지") 충족 → 0.7.0 제거.
- 그 외 dead_code 4건: 각 항목 제거 전 `grep -rn "<symbol>" crates/ examples/`로 소비처 0 재확인 (검증 4계율).
- 제거 후:

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p rustra
cargo fmt --all -- --check
```

- `WireFieldKind`는 사용처 확인 결과 살아있으면 **제거하지 말고 보고**.
- changeset: `@rustra/*` npm 불가 — Rust crate는 Cargo workspace 별도 발행이므로 대신 `docs/versioning-policy` 반영 + 커밋 메시지에 crates.io 발행 시 제거 명시. (crates.io는 changeset 관리 대상이 아님 — release-procedure의 수동 bump 절차에서 처리.)

**10b: 레거시 subscribeEvent 오버로드 2건 제거** — 조사 확정: deprecated 도입이 `69a5a2ae`(2026-08-30, 0.6.0 발행) → 0.7.0에서 "최소 1 마이너 유지" 요건 충족. 폐기 절차에 따라 제거 + CHANGELOG 문서화:
- `packages/tauri/src/tauri-events.ts`에서 `(listen, name, callback)` 오버로드 블록 제거, 남는 시그니처만 유지.
- `packages/react-native/src/react-native-events.ts`에서 `(native, name, cb, options)` 레거시 오버로드 제거.
- 각 패키지 테스트의 레거시 시그니처 사용처 갱신.

**10c: "성능 후속" 라벨 정리** — `ffi_sync_entries.rs:76` 주석을 "(성능 후속)" → 구현 완료 서술로.

**커밋:** 3분리 — `refactor(rustra): deprecated RendererHost 표면 제거 — prelude 재노출 포함` / `refactor(rustra): dead_code 정리 + 성능 후속 라벨 완료 서술 전환` / `refactor(tauri,rn): 레거시 subscribeEvent 오버로드 제거 — 폐기 요건 충족`.

---

### Task 11: changeset 적립 + 최종 게이트

**Files:**
- Create: `.changeset/readiness-tracks.md`
- Create: `.changeset/legacy-subscribe-event-removal.md`

**Step 1: changeset 2개 작성**

`.changeset/readiness-tracks.md`:
```md
---
'@rustra/testing': minor
'@rustra/react': minor
'@rustra/types': minor
'@rustra/node': minor
---

Readiness 트랙: 계약 게이트 필드 수준 강화(commands.ts 필드 키↔schema 대조 + contract hash 대조),
useSuspenseCommand 캐시/무효화 1차, withRetry 유틸, NDJSON 파싱 실패 라인·stderr 보존(RUSTRA_DEBUG),
응답 셰이프 검증 경고.
```

`.changeset/legacy-subscribe-event-removal.md`:
```md
---
'@rustra/tauri': minor
'@rustra/react-native': minor
---

레거시 subscribeEvent 오버로드 제거(0.6.0에서 deprecated 예고, 폐기 요건 충족).
```

**Step 2: 전면 게이트**

```bash
bun test packages/testing packages/types packages/react packages/node packages/tauri packages/react-native packages/cli
bun run test:compat
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
bun run lint && bun run format:check
bun run test:docs && bun run test:onboarding
```

**Step 3: 적대적 재검증** — docs-gate 드리프트 주입→red→원복 (Task 9d에서 했으면 생략).

**Step 4: 커밋** `chore(changesets): readiness 트랙 changeset 적립`.

---

### Task 12: changeset-release/main 로컬 머지 (푸시 전 사용자 확인)

**Step 1: 머지**

```bash
git checkout changeset-release/main
git merge --no-ff feat/readiness-tracks -m "merge: readiness 트랙 — 게이트 강화+캐시+에러품질+문서정직성+위생"
```

**Step 2: 머지 후 게이트 재확인** (bun test 핵심 패키지 + test:docs)

**Step 3: 푸시는 사용자 확인 후** — PR은 이미 열려 있으므로 푸시하면 자동 반영. **`changeset version` 실행 금지** (사용자 승인 시점에만).

---

## 명시적 범위 밖

- 브랜치 통합(feat/tauri-channel-adapter-work) — 사용자 결정 보류
- 레거시 calculator 벤치 제거 — 별도 진행 중(메인 디렉터리)
- `changeset version` 실행/푸시 승인 — 사용자 게이트
- `RendererHost` 제거 — **Task 10a로 이동 (사용자 지시로 0.7.0 제거 확정)**
- 증거 격상(실기기/Windows) — 1.0 트랙
- Suspense 진화 정책(LRU), Electron, WASM — 0.8
