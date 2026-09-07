# 안정화 통합 트랙 구현 계획 (stabilization-unified)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 안정화 통합 문서(2026-09-05, 32개 항목)의 M1~M3 중 자동화 가능한 전부를 한 트랙에 착지 — CI 3개 실패 복구(CI01), 집계 게이트(A01), Tauri 이벤트 3결함(R01~R03), types 코어 계약 통일(R04~R07 잔여, R08 최소), 수명·지원·문서 정합(A02, A04, A05, A07, A10, A12, A13, A17, A18), R09/R10 문서화.

**Architecture:** 워크트리 `.worktrees/stabilization`, 브랜치 `feat/stabilization-unified`. 베이스 = dx 트랙 로컬 머지 후의 `changeset-release/main`. 기존 트랙 리듬 준수 — 태스크별 커밋 → 전면 게이트 → `changeset-release/main` 로컬 머지. 푸시·PR 머지·발행은 사용자 승인 게이트.

**Tech Stack:** TypeScript (bun test), Rust (cargo test/clippy, tauri::test::MockRuntime), GitHub Actions, changesets.

**근거 문서:** 사용자 제공 안정화 통합 문서(2026-09-05) + `docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md`

---

## 재검증 결과 (기준 SHA ebfac5e9 → HEAD 재확인, 2026-09-05)

통합 문서 1.4의 "기준 재확인" 단계 완료. 6개 병렬 검증 + 로컬 재현 결과:

| 항목 | HEAD 기준 상태 | 근거 |
|---|---|---|
| CI01 | **여전** — 3 job 실패 원인 확정: `generated-header.ts`가 JSON/Ruby/XML/shell에 `//` 주석 헤더. typescript job은 로컬 100% 재현 완료 | run 33776685582 로그 + 로컬 codegen 재현 |
| R01 | **여전** — tauri-events.ts:71-79 parse+callback 동일 try | 에이전트 검증 (패키지 기준 SHA 이후 무변경) |
| R02 | **여전** — JS ASCII 정규식 vs Rust `char::is_alphanumeric`, 충돌 거부 0건 | tauri-events.ts:30-36 vs tauri_support.rs:248-258 |
| R03 | **여전** — `emit_str`은 이미 해석된 값을 전달하는데 JS가 재파싱, `payload: string` 타입 오탈 | tauri 2.11.1 소스 검증 포함 |
| R04-a/b/c | **여전** — json-engine.ts:53 truthiness / :55 무 try-catch / :55 normalizeArgs 우회 | json-engine.ts (무변경) |
| R05 | **여전** — cancel.ts:32→38→53 사전검사→dispatch→listener 순서 | cancel.ts (무변경) |
| R06 | **여전** — cancel.ts:98 settled 먼저 → :104 native cancel → :105 reject | cancel.ts (무변경) |
| R07 | **dx 트랙이 대부분 소처** — e5b53055(타임아웃/취소 서브클래스 통일), 3114119b(pre-abort 승격). 잔여: 도착 검증만 | dx 브랜치 커밋 로그 |
| R08 | **여전** — 단일 global 슬롯(Symbol.for), 마지막 bootstrap 승리 | global-state.ts:99-112, node-bootstrap.ts:80,86 |
| R09 | **문서는 존재** — executor.rs:22-33 제한 명시. 잔여: 지원 범위 문서화 | 에이전트 검증 |
| R10 | **여전** — retryable≠안전 구분 문서 부재 | errors.ts isRetryableCode만 존재 |
| A01 | **여전** — 집계 gate job 없음, consumer-smoke가 typescript에 needs로 묶여 skip | ci.yml 전수 (workflow 변경 0건) |
| A02 | **여전** — EngineClient에 supports 표면 없음(코덱 비트마크 조각만) | public.ts:6-32 |
| A03 | **부분** — Node loop-stdio+Tauri MockRuntime sink는 검증 존재. 잔여: Tauri JS 어댑터 이벤트, RN 실호스트 | event_push.rs 4테스트, node index.test.ts |
| A04 | **여전** — allSettled 표면 0건 | 전 패키지 grep |
| A05 | **부분** — generation 가드+drain 프리미티브 존재. 상태 모델·dispose-once·reload drain 미연결 | global-config.ts:38-43, node-loop.ts:384-400 |
| A07 | **여전** — `rustra_dispatch_profiled`가 기본 register에 포함 | tauri_support.rs:156-160 |
| A09/A15/A16 | **여전** (P2/P3 — 이번 사이클 수동 체크리스트·보류) | ffi_free_guard.rs 등 |
| A10 | **dx 트랙이 버전 스니펫 소처** — README `rustra = "0.6"`. 잔여: Cargo 0.5.0 vs npm 0.6.0 조합 문서 | dx 브랜치 README:149 |
| A11 | **보류** — 발행은 사용자 게이트 | release-procedure |
| A12 | **여전** — README.md:32 "manual d.ts" 그대로 | dx 브랜치에서도 무변경 |
| A13 | **여전** — "rkyv V2" 명칭+11.8× 표현 그대로 (manifest는 postcard) | README.md:33 |
| A14 | **readiness 트랙이 4건 소처** — CHANGELOG 0.6, ko 미러, on_unimplemented 정정, docs-gate 결정 고정 | changeset-release/main 커밋 |
| A17/A18 | **여전** — calculator가 대표 소비자, 증거표 존재 | README.md:622-628 |
| F01~F03 | **부분** — percentile+면책 존재, receipt에 SHA/artifact 식별자 부재 | docs/benchmark-receipts/ |

## 이번 사이클 착지 vs 보류

**착지 (태스크 1~16):** CI01, A01, R01, R02, R03, R04-a/b/c, R05, R06, R07(도착 검증), R08(최소 가드+문서), R09(문서), R10(문서), A02(최소 supports), A03(자동화분+수동 체크리스트), A04, A05, A07, A10(조합 문서), A12, A13, A17(여정 확장), A18(증거 수준 명시), F01(receipt에 SHA 필드 — 최소).

**보류 (명시):** A06(위협 모델 — 격리 요건이 생길 때), A08(overload 계측 — 측정 근거 선행), A09(sanitizer — native 환경, 수동 체크리스트로만), A11(발행 후 검증 — 발행 승인 후), A14 잔여(quickstart CI 스모크 — 별도), A15/A16(P3 리팩터링), F02/F03(실기기·실부하 — 하드웨어 필요), 채널 어댑터 트랙 통합(별도 결정).

---
## Phase 0: 기반 준비

### Task 0: 워크트리 생성 + dx 트랙 로컬 머지 (사용자 승인 사항 포함)

**Files:** 없음 (git 조작만)

**Step 1: dx 트랙을 changeset-release/main에 로컬 머지** — **실행 전 사용자 확인 필요.** 기존 트랙 리듬(쌓인 트랙 로컬 머지, push는 별도 승인)을 따른다. dx 트랙의 changeset은 없었으므로(검증 완료: `.changeset/` diff 0) 머지 후 changeset 적립은 이 트랙(Task 16)에서 일괄.

```bash
cd /Users/loopy/dev/ll3/rustra-bridge
git checkout changeset-release/main
git merge --no-ff feat/dx-friction-track -m "merge: DX 마찰 제거 트랙 — codegen 정합+에러 정규화+capability 게이트+온보딩 E2E"
```

**Step 2: 머지 후 게이트 재확인**

```bash
bun install --frozen-lockfile
bun test packages/types packages/cli packages/node packages/bun packages/tauri packages/testing packages/react
cargo clippy --workspace --all-targets -- -D warnings
bun run test:docs
```

Expected: 전부 PASS. red면 머지 문제로 보고하고 정지.

**Step 3: 안정화 워크트리 생성**

```bash
git worktree add .worktrees/stabilization -b feat/stabilization-unified changeset-release/main
cd .worktrees/stabilization
bun install --frozen-lockfile
```

**Step 4: 베이스라인 기록** — HEAD SHA, `git log --oneline -1` 출력을 작업 노트에 남긴다.

---

### Task 1: CI01 — generated 헤더 형식 판정 (실패 3개의 단일 근원)

**Files:**
- Modify: `packages/cli/src/generated-header.ts`
- Test: `packages/cli/src/generated-header.test.ts`
- Regen: `examples/react-native-calculator/modules/rustra-jsi/**`, `examples/react-native-bare-calculator/**` (codegen 재실행)

**재확정된 원인 (로컬 재현 완료):** `generatedFileHeader()`가 무조건 `//` 라인을 7개 내보낸다. `package.json`(JSON — 주석 문법 없음), `RustraBridge.podspec`(Ruby), `AndroidManifest.xml`(XML), `build-rust-android.sh`(shebang 선행 필요)에 찍히면 파일이 파괴된다.
- typescript job: codegen이 `modules/rustra-bridge/package.json`에 헤더 → `react-native config` JSON 파싱 사망 → `test:autolink` exit 1 (로컬 100% 재현)
- rn-ios: pod install이 podspec의 `//` 라인에서 Ruby SyntaxError
- rn-android: settings.gradle line 29 autolinking 커맨드(node)가 동일 JSON 파싱 사망

**설계 결정:** 헤더 문법을 확장자별로 판정한다. JSON은 RFC 8259상 주석이 불가하므로 **헤더를 넣지 않는다**(대신 `.rustra-generated.json` 매니페스트가 이미 출처 추적 — 단일 진실원 유지). shebang 파일은 shebang 뒤에 부착. Ruby/XML/CMake/Gradle은 각 네이티브 주석 문법.

**Step 1: 실패하는 테스트 작성** — `generated-header.test.ts`에 추가:

```ts
import { generatedFileHeader, headerFor } from './generated-header.js';

// 기존 TS 테스트 유지 + 신규:
test('json 파일은 주석 문법이 없어 헤더를 찍지 않는다', () => {
  expect(generatedFileHeader('package.json', 'test', '"name": "x"')).toBe('"name": "x"');
});
test('shell은 shebang 뒤에 # 주석 헤더를 부착한다', () => {
  const out = generatedFileHeader('run.sh', 'test', '#!/bin/sh\nset -e\n');
  expect(out).toMatch(/^#!/);
  expect(out).toContain('# ── rustra generated');
  expect(out.startsWith('#!/bin/sh')).toBe(true);
});
test('ruby podspec은 # 주석 헤더를 부착한다', () => {
  const out = generatedFileHeader('RustraBridge.podspec', 'test', 'Pod::Spec.new\n');
  expect(out.startsWith('# ── rustra generated')).toBe(true);
});
test('xml은 <!-- --> 헤더를 부착한다', () => {
  const out = generatedFileHeader('AndroidManifest.xml', 'test', '<manifest>\n');
  expect(out.startsWith('<!--')).toBe(true);
});
test('cmake/gradle/kotlin/cpp는 // 헤더를 유지한다', () => {
  expect(generatedFileHeader('build.gradle', 'test', 'plugins {}\n').startsWith('// ── rustra')).toBe(true);
  expect(generatedFileHeader('CMakeLists.txt', 'test', 'cmake_minimum_required\n').startsWith('// ── rustra')).toBe(true);
});
test('헤더 파싱 헬퍼 headerFor가 스트립을 대칭 달성한다', () => {
  const content = 'x\n';
  const wrapped = generatedFileHeader('a.kt', 't', content);
  expect(headerFor(wrapped, 'a.kt')).toBe(content);
});
```

**Step 2: 실패 확인** — `bun test packages/cli/src/generated-header.test.ts` → `generatedFileHeader` 시그니처(3인자)+`headerFor` 미존재로 FAIL.

**Step 3: 구현** — `generated-header.ts`:

```ts
type HeaderSyntax = 'slash' | 'hash' | 'xml' | 'none';

function syntaxFor(fileName: string): HeaderSyntax {
  if (fileName.endsWith('.json')) return 'none';          // JSON — 주석 불가, 매니페스트가 출처
  if (/\.(sh|podspec|rb|py|ya?ml|properties|toml|gitignore)$/.test(fileName)) return 'hash';
  if (/\.(xml|html|md)$/.test(fileName)) return 'xml';
  if (/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|CMakeLists\.txt)$/.test(fileName)
    || /\.(kt|kts|java|c|cpp|h|hpp|mm|m|cc|swift|rs|ts|tsx|js|mjs|cjs|cts|mts)$/.test(fileName)) return 'slash';
  return 'slash';
}

function commentLines(fileName: string, stage: string, opener: string, closer?: string): string[] {
  const body = [
    `${opener} ── rustra generated ────────────────────────────────`,
    `${opener} File:   ${fileName}`,
    `${opener} Source: schema.json (single source of truth for this file)`,
    `${opener} Regen:  rustra codegen --config rustra.json`,
    `${opener} Stage:  ${stage}`,
    `${opener} DO NOT EDIT — changes will be overwritten and fail codegen --check.`,
    `${opener} ────────────────────────────────────────────────────────────`,
  ];
  if (closer) return [...body.map((l) => `<!--${l.slice(opener.length)}...`)].map((l) => l) as string[];
  return body;
}
```

주의: 위 스케치는 의도 전달용 — 구현 시 XML 라인은 `<!-- ... -->`로, `none`은 원문 반환, shebang 검출(`content.startsWith('#!')`) 후 hash 헤더를 2행째부터 삽입. `headerFor(content, fileName)`은 역방향 스트립(codegen --check와 .rustra-generated.json 매니페스트 대조 경로가 이미 있으므로 이 헬퍼는 테스트 대칭성 증명용 최소 구현 — 기존 검증 경로와 중복 만들지 말 것).

**핵심 검증 지점:** `packages/cli/src/cli-generate-files.ts:86`의 `${generatedFileHeader(name, stageFor(name))}${content}` 호출부가 전달하는 `name`이 확장자를 포함하는지 실측하고, 포함하지 않으면 호출부에서 실제 파일명을 넘기도록 수정한다.

**Step 4: 테스트 PASS 확인.**

**Step 5: 생성물 재생성 + 형식 검증**

```bash
cd examples/react-native-bare-calculator && bun run codegen && bun run typecheck && bun run test:autolink
cd ../../examples/react-native-calculator && bun run codegen 2>/dev/null || bun ../../packages/cli/src/index.ts codegen --config rustra.json
head -1 modules/rustra-jsi/package.json   # '{' 로 시작해야 함
ruby -c modules/rustra-jsi/RustraBridge.podspec   # Syntax OK
```

Expected: autolink PASS, package.json이 `{`로 시작, podspec `Syntax OK`.

**Step 6: 전체 codegen 스냅샷 게이트** — 다른 예제(calculator/crud/auth) 재생성 후 diff 0 확인 (`codegen --check` 또는 재생성→`git diff`).

**Step 7: 커밋** `fix(cli): generated 헤더 형식 판정 — JSON 무헤더·shebang 존중·Ruby/XML 네이티브 주석 (CI01 근원)`

---

### Task 2: CI01 검증 — 3개 실패 job의 로컬 재현 경로 통과

**Files:** 없음 (검증만)

**Step 1: bare fixture 전 경로** — `install → codegen → typecheck → test:autolink` (Task 1의 Step 5와 동일, 통과 확인).

**Step 2: pod install 로컬 재현** (macOS + CocoaPods 환경):

```bash
cd examples/react-native-calculator
bunx expo prebuild --platform ios --no-install
cd ios && pod install --project-directory=.
```

Expected: Ruby SyntaxError 없이 진행(네트워크 의존 단계 실패 시 그 로그를 남기고 RN-job 나머지는 CI에서 재검증 — 수동 체크리스트에 기록).

**Step 3: Android settings.gradle 경계** — `bunx expo prebuild --platform android --no-install` 후 settings.gradle 생성물 확인(주입 커맨드가 node 스크립트 — package.json 파싱). 로컬 그레이들 빌드가 무거우면 `react-native config` 재실행으로 JSON 경계만 증명하고 기록.

**Step 4: 커밋 없음** — 결과를 작업 노트에 기록. (CI 전면 재검증은 푸시 후 — 사용자 게이트.)

---

### Task 3: A01 — 독립 job 집계 gate + 실패 로그 보존

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/ci-gate-test.md` 아님 — 검증은 수동 fault-injection (아래 Step 4)

**설계:** 신규 `gate` job을 마지막에 추가:

```yaml
gate:
  needs: [rust, rust-msrv, rust-wasm32, rust-audit, rust-deny, napi, typescript, rn-android, rn-ios, consumer-smoke]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - name: Aggregate mandatory results
      run: |
        # needs 컨텍스트로 성공 판정 — skipped/cancelled는 실패 취급
        # (GitHub 표준: needs.<id>.result in ('success')만 통과)
```

정확한 표현은 `needs` 결과를 전개하는 방식이 필요하므로 구현 시 GitHub 공식 패턴(각 job에 `outputs.result` 노출 → gate에서 all(...) 판정, 또는 `if: always() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') && !contains(needs.*.result, 'skipped')`)으로 확정. **consumer-smoke의 needs 체인 유지**(typescript 실패 시 skip → gate 실패 — 원 의도 보존).

**추가:** rn-ios/rn-android/typescript 실패 시 로그 artifact 업로드 단계 추가(`if: failure()`, `actions/upload-artifact@v7` — xcodebuild.log, gradle 로그. 민감정보 마스킹: `::add-mask::` 사용).

**Step 1: workflow 수정.** **Step 2: `actionlint`로 정적 검증** (`brew install actionlint` 또는 docker). **Step 3: fault-injection 검증** — 임시 커밋으로 typescript 스텝 하나를 `exit 1`로 조작 → 푸시 없이 로컬 판정 로직 검증이 불가하므로, **gate 논리를 별도 셸 스크립트로 추출해 유닛 테스트**(스크립트에 failure/skipped/cancelled/mixed 입력 → 실패 판정 유닛 테스트)한 뒤 workflow는 그 스크립트를 호출. **Step 4: 원복 후 커밋** `ci: 필수 job 집계 gate + 실패 로그 artifact 보존 (A01)` — fault-injection 실증(T24)은 푸시 후 첫 CI run에서 확인하고 이를 작업 노트에 기록.

---
## Phase 2: Tauri 이벤트 결함 (R01~R03, A03 자동화분)

### Task 4: R01 — 콜백 예외 경계 분리 + MockRuntime 회귀 테스트

**Files:**
- Modify: `packages/tauri/src/tauri-events.ts:71-79`
- Test: `packages/tauri/src/index.test.ts` (기존 mock `__TAURI__` 패턴)
- Test: `examples/tauri-calculator/src-tauri/tests/event_push.rs` (Rust 측 sink는 무변경 — TS 경계만)

**설계 (통합 문서 요구):** transport payload 변환(JSON.parse)과 사용자 콜백을 다른 오류 경계로 분리.

```ts
const unlisten = await listen(rustraEventChannel(name), (event) => {
  let payload: T;
  try {
    payload = JSON.parse(event.payload) as T;   // ← transport 변환 경계 (R03에서 추가 축소)
  } catch (error) {
    // 파싱 실패: 원본 문자열 전달 — 단, 이것이 콜백 "재호출"이 아닌 유일한 1회 전달이다.
    callback(event.payload as unknown as T);
    return;
  }
  // 사용자 콜백은 자기 경계 — 예외는 listener error 정책으로 관측 가능하게.
  try {
    callback(payload);
  } catch (error) {
    reportListenerError(name, error);  // RUSTRA_DEBUG 시 console.error + 콜백 예외는 재던지지 않음(다른 listener 보호)
  }
});
```

`reportListenerError`는 tauri 패키지 신설 헬퍼 — `@rustra/types`의 debug 스위치(`debugRustra`)를 재사용해 `{ kind: 'tauri.listener_error', event: name, error }`로 관측. 다른 listener 중단 정책: **예외 삼켜서 나머지 listener 계속**(브라우저 EventTarget 표준 동작과 동일) — 문서와 테스트로 고정.

**Step 1: 실패 테스트** — 기존 index.test.ts의 `subscribeEvent` 스위트에:
1. 정상 payload + throwing callback → callback 호출 **1회**, debug sink에 `tauri.listener_error` 도달, promise resolve.
2. 정상 payload + 정상 callback → 1회.
3. 잘못된 JSON text + callback → 1회, 인자가 원본 string.
4. listener 2개 중 1개 throw → 다른 listener는 정상 호출.

**Step 2: FAIL 확인** (`bun test packages/tauri`).

**Step 3: 구현 + PASS.**

**Step 4: 커밋** `fix(tauri): 이벤트 콜백 예외 경계 분리 — 재호출 제거 + listener error 관측 (R01)`

---

### Task 5: R02 — 이벤트 채널명 규칙 통일 + 충돌 거부

**Files:**
- Modify: `packages/tauri/src/tauri-events.ts:30-36` (`rustraEventChannel`)
- Modify: `crates/rustra/src/tauri_support.rs:248-258` (`sanitize_event_name`)
- Modify: `crates/rustra/src/builder_events.rs:28-35` (등록 시 충돌 검증)
- Test: `packages/tauri/src/index.test.ts`
- Test: `examples/tauri-calculator/src-tauri/tests/event_name_mapping.rs` (신설)
- Fixture: 코드젠 event name golden — `examples/calculator/generated/tauri.ts` 비교

**설계 결정 (통합 문서 9.3 권장 방향):** 공통 규칙 = **Unicode-aware, 양측 동일 알고리즘** + 등록 시 충돌 거부. 장기 가역 인코딩은 YAGNI(스키마에 고정 이름이면 충돌이 구조적으로 불가 — 등록 거부가 최소 완전 해결).

공통 알고리즘(양측 동일 명세):
1. 코드포인트 단위 처리(JS는 `[...str]`, Rust는 `chars()`).
2. 허용: `[A-Za-z0-9/_:-]` + `char::is_alphanumeric()` (Unicode 알파벳·숫자 — 한글·한자 유지).
3. 그 외(구두점·기호·공백) → `_` (치환).
4. **충돌 거부**: 같은 패키지 내 서로 다른 원본 이름이 같은 채널로 수렴하면 `Package::build` 시 panic(빌더 계약 — `builder_events.rs`에서 정규화 맵 구축, 중복 발견 시 `panic!("event channel collision: {a!r} and {b!r} both map to {ch}")`). Unicode NFC 정규화는 수행하지 않음(정규화로 같아지는 이름도 다른 이름 — 거부 대상; 이 선택을 Rust/TS 문서에 명시).

**Step 1: 실패 테스트 (Rust)** — `event_name_mapping.rs`:
- golden: `진행.갱신`→`rustra://진행_갱신`, `a.b`→`rustra://a_b`, 결합문자, 비BMP(emoji) 포함 케이스 — Rust `sanitize_event_name` 단위 assert.
- 충돌 거부: `event::<A>("a.b")` + `event::<B>("a_b")` 빌드 → panic (should_panic 테스트).
- MockRuntime 발행·구독 정합: 한글 이벤트 emit → `app.listen("rustra://진행_갱신")` 도달.

**Step 2: 실패 테스트 (TS)** — `rustraEventChannel('진행.갱신') === 'rustra://진행_갱신'`, `'a.b' === 'rustra://a_b'`, emoji 케이스 golden 공유(Rust와 같은 표 생성 — 테스트에 리터럴로 박아 양측 드리프트 방지).

**Step 3: FAIL 확인** (Rust: `cargo test -p rustra-tauri-calculator --test event_name_mapping` / TS: `bun test packages/tauri`).

**Step 4: 구현** — TS `rustraEventChannel`을 코드포인트 순회(`for..of`)+`/\p{L}|\p{N}/u` 판정으로 교체. Rust는 기존 로직 유지(이미 Unicode-aware)하되 **builder 충돌 검증 신설**. JS 측 충돌은 빌드 타임 Rust가 단일 진실원이므로 런타임 거부 불필요(등록은 Rust만).

**Step 5: PASS + golden 동기 확인** — `cargo test` + `bun test packages/tauri` + `bun run test:docs`(generated tauri.ts 재생성 대상 있으면 갱신).

**Step 6: 호환성 기록** — 구 JS(ASCII 치환)로 한글 이벤트를 구독하던 조합은 신 Rust에서 수신 불가가 **됨**(기존에도 수신 불가였음 — 구 JS가 `rustra://________`를 구독하고 Rust는 `rustra://진행_갱신` 발행. 즉 기존에도 이미 불일치로 유실 상태였으므로 신규 유실 없음. 이 판정을 커밋 메시지와 문서에 기록).

**Step 7: 커밋** `fix(tauri,rustra): 이벤트 채널명 Unicode 규칙 통일 + 빌드 타임 충돌 거부 (R02)`

---

### Task 6: R03 — payload 단일 파싱 계약 확정 + 타입 정정

**Files:**
- Modify: `packages/tauri/src/tauri-events.ts` (`subscribeEvent` 본체, Task 4 코드의 parse 경계)
- Modify: `packages/tauri/src/index.ts:63-66` (`TauriListen` payload 타입)
- Test: `packages/tauri/src/index.test.ts`
- 문서: `docs/compatibility-matrix.md`+ko (Events 행 Tauri 셀 보강), `crates/rustra/src/tauri_support.rs:179-185` doc은 이미 올바름 — 무변경

**설계:** 실제 WebView 경계(`emit_str` → `payload: {}` 인라인 평가, tauri 2.11.1 검증 완료)에서 JS listener는 **이미 해석된 값**을 받는다. 따라서:
1. `subscribeEvent`의 payload 처리는 **"이미 객체면 그대로, 문자열이면 JSON.parse 1회"** — 문자열 내용 기반 자동 추론은 하지 않는다(문자열이면 문자열 payload였던 것).
2. `TauriListen` 타입을 `handler: (event: { payload: unknown }) => void`로 정정하고, `subscribeEvent`는 `typeof payload === 'string'`일 때만 parse. parse 실패 시 원본 문자열 전달(Task 4 경계 유지).
3. 레거시 주입 transport(`__TAURI__`가 `payload`를 문자열로 주는 fake)는 위 규칙으로 자동 커버 — 별도 모드 불필요. 이 결정을 JSDoc에 명시.

**Step 1: 실패 테스트** — 이미 해석된 object payload → 그대로 전달(parse 안 함, `typeof` 보존); 문자열 `'{"a":1}'` → 객체로; 문자열 `'123'`(문자열 payload) → **문자열 `'123'` 그대로**(number 아님 — 통합 문서 회귀 시험 표의 핵심); null/불리언/빈 문자열/일반 텍스트/escape 포함 각각 typeof+null 여부 assert.

**Step 2: FAIL 확인.** **Step 3: 구현 + PASS.**

**Step 4: MockRuntime 레벨 정합 테스트** — `event_push.rs` 패턴으로 Rust emit_str → JS 규칙 시뮬레이션은 TS 테스트에서 실제 emit payload 형태(tauri가 직렬화한 JSON 문자열)를 재현하는 fixture로 고정. 실제 WebView 스모크는 Task 15(수동 체크리스트).

**Step 5: 커밋** `fix(tauri): 이벤트 payload 단일 파싱 계약 — decoded 우선·문자열만 1회 parse (R03)`

---
## Phase 3: types 코어 계약 통일 (R04~R08)

**선행 상태 주의:** dx 트랙이 `cancel.ts`/`cancel-by-id.ts`/`global-batch.ts`/`global-config.ts`를 이미 고쳤다(에러 서브클래스 통일 — Task 6 머지 완료 후 베이스에 존재). 아래 구현은 **dx 이후 코드 위에서** 진행하며, 시작 시 `git diff bd72610b..HEAD -- packages/types/src/cancel.ts`로 dx 변경분을 먼저 읽는다.

### Task 7: R04 — batch 경로 옵션·정규화·동기 throw 계약 통일

**Files:**
- Modify: `packages/types/src/json-engine.ts:48-56`
- Test: `packages/types/src/index.test.ts`

**수정 내용 (재검증 확정 3건):**
1. **R04-a**: `:53`의 `entry.options?.timeoutMs` truthiness → `entry.options?.timeoutMs !== undefined`로 판정 변경. `0`은 "제공된 옵션"으로 per-entry 폴백 경로를 태워야 한다(단건 경로 cancel.ts:42와 동일 판정). NaN/Infinity/음수 정책: 기존 단건 경로와 동일하게 유지(setTimeout이 비정상 값을 즉시 실행으로 처리하는 브라우저 동작 의존 — 통합 문서의 "호스트 timer 범위 초과 정책 명시"는 R10 문서 태스크에서 다룬다).
2. **R04-b**: `:55` `Promise.resolve(rawTransport.invokeBatch(entries))`를 try/catch로 감싸 동기 throw → `Promise.reject(normalizeRustraError(error))` (단건 경로 :26-41 패턴 동일).
3. **R04-c**: wire batch 진입 전 각 entry의 args에 `normalizeArgs` 적용 — 단, dx 트랙이 global-batch에 적용한 방식이 있으면 그것과 같은 규칙. entry 객체 재생성 시 **원본 배열·원본 entry를 변이하지 않는다**(새 entry 객체).

**Step 1: 실패 테스트** — 통합 문서 회귀 표 기준:
1. delayed transport + `timeoutMs: 0` → 단건과 동일하게 즉시 timeout rejection (직접 engine).
2. 동기 throwing batch transport → Promise rejection (동기 throw 아님), `normalizeRustraError` 통과.
3. custom normalizer 주입 → wire batch에서도 entry별 적용, 원본 entries 불변.
4. signal 혼합 entry → 기존 폴백 경로 유지 확인.
5. 빈 batch → `[]` (기존 동작 회귀 방지).
6. 각 케이스를 전역 facade(`invokeBatch`)와도 병행 실행 — 경로 간 결과 동일.

**Step 2: FAIL 확인.** **Step 3: 구현.** **Step 4: PASS.**

**Step 5: batch timeout 정책 불변 확인** — 전역 batch의 "최소 timeout으로 전체 race" 정책(dx 트랙 이후에도 유지 중)을 변경하지 않았음을 테스트로 고정(기존 테스트 존재 — 회귀 없음만 확인).

**Step 6: 커밋** `fix(types): wire batch 옵션·정규화·동기 throw 계약 통일 — 단건과 동일 판정 (R04)`

---

### Task 8: R05 — dispatch 중 abort 누락 제거

**Files:**
- Modify: `packages/types/src/cancel.ts` (`invokeWithTimeoutInternal`)
- Modify: `packages/types/src/cancel-by-id.ts` (동일 패턴)
- Test: `packages/types/src/index.test.ts`

**수정 설계 (dx 트랙 이후 코드 기준 — dx가 이미 서브클래스만 바꿨다면 구조는 동일):** listener 등록을 dispatch **전**으로 이동하는 것이 아니라, **등록-직후 재검사**로 닫는다(표준 AbortSignal 경합 패턴 — listener 등록은 이벤트 유실 없이 가능):

```ts
// dispatch 후 listener 부착 직후:
if (signal) {
  races.push(new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError(...));
    signal.addEventListener('abort', onAbort, { once: true });
    // ← 신규: 등록 직후 재검사 — dispatch 동기 구간의 abort를 놓치지 않는다
    if (signal.aborted) { onAbort(); return; }
  }));
}
```

주의: `addEventListener`는 이미 aborted인 signal에서도 리스너를 등록하지만 이벤트를 재발화하지 않으므로 재검사가 필수. 재검사-시점 reject는 settlement 경계(`settled` 플래그/`Promise.race` 한 번 확정)에서 이후 resolve와 자연 경합 — **Promise settlement 정확 1회** 불변.

**Step 1: 실패 테스트** — 통합 문서 회귀 시나리오:
1. pre-abort → dispatch 0회 (기존 — 회귀 방지).
2. **dispatch 내부 동기 abort** (transport invoke 안에서 `controller.abort()` 후 정상 resolve) → cancel rejection. **이것이 핵심 신규 케이스.**
3. 진행 중 abort(비동기) → 기존 동작 유지.
4. 정상 완료 후 abort → 결과 불변.
5. resolve와 abort 재진입, 중복 abort → settlement 1회.
6. listener cleanup — 완료 후 onAbort 제거(기존 cleanup 경로 유지).

제어는 실시간 sleep 대신 deferred transport + 호출 카운터로.

**Step 2: FAIL 확인 (케이스 2만 red여야 함).** **Step 3: 구현(두 파일 동일 패턴).** **Step 4: PASS + by-id/generated 경로 동일 시나리오 병행.**

**Step 5: 커밋** `fix(types): dispatch 중 동기 abort 관측 — listener 등록 직후 재검사 (R05)`

---

### Task 9: R06 — native cancel 예외와 Promise 완료 분리

**Files:**
- Modify: `packages/types/src/cancel.ts` (`invokeCallbackWithAbort` onAbort)
- Test: `packages/types/src/index.test.ts`

**수정 설계:**

```ts
const onAbort = () =>
  finish(() => {
    let cancelFailure: unknown;
    if (cancel && invocationId >= 0) {
      try {
        cancel(invocationId);
      } catch (error) {
        cancelFailure = error;   // JS 결과 확정을 native cancel 성공에 묶지 않는다
      }
    }
    reject(new CancelledError(`invoke("${command}") aborted`, cancelFailure));
    // cancel 실패는 cause로 보존 — 통합 문서 "별도 관측 정보" 요구의 최소 구현
  });
```

추가 검토(구현 시 실측): `cancel` 미지원(undefined)·invocationId 수신 전(`invocationId < 0`)·이미 완료(`settled`) 3구분이 기존 코드에 존재하는지 확인하고, 없으면 onAbort 진입 순서로 자연 커버됨을 테스트 주석으로 명시. R07 연결: `CancelledError`에 cause를 흘려보내는 것이 기존 errors.ts 생성자 시그니처와 맞는지 실측(dx 트랙 이후 코드 기준).

**Step 1: 실패 테스트** — ① throwing cancel + signal double → **Promise rejection으로 확정**(pending 잔류 없음), cause에 cancel 예외 보존. ② 정상 cancel → 기존. ③ cancel undefined → 기존 rejection. ④ completion이 cancel보다 늦게 도착 → 결과 불변. ⑤ completion 중복 → 무시. ⑥ 실제 AbortSignal로도 동일(주입 double과 실제의 범위 구분 주석).

**Step 2: FAIL 확인.** **Step 3: 구현 + PASS.** **Step 4: 커밋** `fix(types): native cancel 예외와 JS settlement 분리 — cause 보존 (R06)`

---

### Task 10: R07 도착 검증 + R08 최소 가드

**Files:**
- Test: `packages/types/src/index.test.ts` (R07 도착 검증만)
- Modify: `packages/types/src/global-config.ts` + `packages/node/src/node-bootstrap.ts` (R08 최소)
- 문서: `docs/rust-api-guide.md`+ko (bootstrap 소유권 절 신설), `docs/compatibility-matrix.md`+ko
- Test: `packages/node/src/index.test.ts` (R08 회귀)

**10a — R07 도착 검증 (구현 최소화):** dx 트랙(e5b53055, 3114119b)이 timeout→TimeoutError, cancel→CancelledError, pre-abort 승격을 착지했다. 여기에 통합 문서 회귀 T09의 **나머지 축만 추가**:
1. wire가 구조화 `{code:'transport.timeout'}`을 줄 때 `normalizeRustraError` 승격 → `instanceof TimeoutError` (기존 errors.ts:90-95 — 회귀 고정).
2. 전역 batch timeout race → TimeoutError (dx 이후 코드에서 확인, 없으면 dx 스타일 승격 보강).
3. `cause`/`retryable` 보존 — 서브클래스 경유 시에도 유지.
4. 부작용 검증: 기존 사용자 code 커스텀 RustraCommandError가 normalize를 통과 시 원본 보존(errors.ts:85 — 회귀 고정).

**10b — R08 최소 가드 (이번 사이클):** 통합 문서 R08은 "다중 엔진 사용 전 P1" — 다중 엔진 API는 이번 사이클 범위 밖이되, **단일 엔진 제한을 명시하고 조용한 교차 라우팅을 loud-fail로 바꾼다**:
1. `node-bootstrap.ts`의 `configureLazy(bootstrap)` 호출부에서, global 슬롯에 **이미 다른 initializer가 등록돼 있고 아직 소비되지 않은 경우**(`runtime.engine === null && engineInitializer !== bootstrap` && generation 소비 전) → `throw`(또는 debug warn+문서 경로) — import 순서로 마지막 bootstrap이 조용히 이기는 현재 동작을 조기에 잡는다. 정책: **첫 등록 승리 + 이후 등록은 loud-fail**(기존 단일 사용자 경로 보존, 교차 라우팅 제거). 구현 디테일은 global-config의 configure/configureLazy에 `ownerId` 옵션 추가로.
2. bun-ffi.ts도 동일 관용 확인(같은 configureLazy 경로면 자동 커버).
3. 문서: rust-api-guide에 "bootstrap 인스턴스 소유권 — 현재 단일 엔진 슬롯, 다중 엔진은 미지원(조기 실패)" 절 + compatibility-matrix에도 반영.

**Step 1: 실패 테스트 (R08)** — A bootstrap 후 B bootstrap 등록(둘 다 ready 전) → B 등록 시 loud-fail; A ready → A의 engine으로 dispatch; dispose 후 재configure → 허용(재초기화 경로 유지). 모듈 import 순서 변경 시나리오는 worker 격리 테스트로.
**Step 2: FAIL → 구현 → PASS.** (R07 테스트는 대부분 green — **도착 검증이므로 FAIL이 나오면 그것이 dx 미커버 영역이고 그때만 최소 보강**.)
**Step 3: 커밋 2개** — `test(types): R07 도착 검증 — wire 승격·cause 보존·커스텀 에러 회귀 고정` / `feat(types,node): bootstrap 단일 슬롯 loud-fail 가드 — 교차 라우팅 조기 차단 (R08 최소)`

---

### Task 11: R09·R10 문서화 (동작 변경 없음)

**Files:**
- Modify: `docs/rust-api-guide.md` + `.ko.md` (R09: executor 지원 범위 절 / R10: timeout·취소·재시도 의미 절)
- Modify: `docs/compatibility-matrix.md` + `.ko.md` (취소 ⚠️ 셀 상세 각주)
- Modify: `packages/types/src/public.ts` (InvokeOptions JSDoc — shallow cancel 경고 보강)
- Modify: `.changeset/` 문서 전용이라 changeset 불필요 (기존 관례)

**R09 문서 내용 (재검증 확정 근거 기반):** executor.rs:22-33의 명시된 제한을 소비자 문서로 승격 — ① `block_on`은 현재 스레드 park(호스트 런타임 워커 굶김 — spawn_blocking 필요), ② thread-local State는 spawned task에서 보이지 않음(명시적 capture 안내), ③ FFI pool worker 2·queue 256·fail-fast backpressure(`invoke.backpressure`) 상수와 대응, ④ async 문법 등록 가능 ≠ 범용 async I/O runtime 제공 — 지원하는 future 종류 명시. executor 주입은 지원하지 않음을 명시(필요성 측정 후 별도 트랙 — A08과 함께).

**R10 문서 내용:** ① `retryable=true` ≠ "재실행 안전" — shallow cancel/timeout 후 Rust 명령은 계속 실행됐거나 완료됐을 수 있음(부작용 중복 경고). ② "응답을 받지 못함 ≠ 명령이 실행되지 않음" 구분 안내 + 상태 재조회 패턴 예시. ③ withRetry(readiness 트랙에서 착지됨)의 안전 사용 — 비멱등 명령에 무조건 재시도 금지, `retryIf`로 멱등 명령만. ④ batch reject가 rollback을 뜻하지 않음 명시(A04와 연결). ⑤ InvokeOptions JSDoc에 요약 + 가이드로 링크.

**검증:** `bun run test:docs`(게이트) + 양언어 문서 대조. **커밋** `docs(guides): async executor 제한 + timeout/취소/재시도 의미 분리 (R09/R10)`

---

### Task 12: A02 — 최소 supports 표면 + A05 수명 상태 모델

**Files:**
- Modify: `packages/types/src/public.ts` (EngineClient에 `supports?` 추가)
- Modify: `packages/node/src/node-loop.ts`, `packages/node/src/index.ts` (supports 제공)
- Modify: `packages/tauri/src/index.ts`, `packages/bun/src/bun-ffi.ts` (supports 제공)
- Test: 각 패키지 테스트
- 문서: `docs/compatibility-matrix.md`+ko — supports 정의와 매트릭스 연결

**A02 설계 (최소 — 통합 문서 "기술적 지원과 권한 분리"는 capability가 이미 있으므로 기술적 지원만):**

```ts
export type EngineSupports = {
  cancellation: 'pre-abort' | 'shallow' | 'cooperative';  // 실측: node/bun=rkyv conditional, json=pre-abort+shallow
  batch: 'single-crossing' | 'per-entry' | 'none';
  events: 'push' | 'polling' | 'none';
  channels: boolean;
  timeoutPreemption: boolean;  // RN JSON = false (동기 native 선점 불가)
};
// EngineClient에 supports?: EngineSupports
```

초기값은 **기존 compatibility-matrix의 각 셀을 기계 판독 가능하게 옮긴 것** — 새 주장 없음. 각 어댑터의 engine 생성 함수가 자신의 supports를 채운다. 앱은 `engine.supports?.cancellation === 'cooperative'` 같이 부작용 이전 검사 가능.

**A05 설계 (최소 상태 모델):** R08 loud-fail 가드 위에 bootstrap 로컬 상태 3종만 — `'initializing' | 'ready' | 'disposed'` (draining은 drain 미연결 상태라 문서로만: node-loop의 `drain()`은 존재하나 reload가 호출하지 않음 → **reload 경로에 drain 연결**(기존 시그니처 유지, 타임아웃 후 진행)). dispose-once: 두 번째 dispose는 no-op(기존 멱등 유지)하되 dispose 후 ready는 loud-fail.

**Step 1: 실패 테스트** — ① 각 어댑터 supports 존재+기대값(매트릭스 셀과 1:1). ② reload 시 drain 호출 확인(spy transport). ③ dispose 후 ready → rejection. ④ ready×2 동시 → 동일 promise 공유(기존 ensureConfigured — 회귀 고정).
**Step 2: FAIL → 구현 → PASS.** **Step 3: 문서 갱신 + 커밋** `feat(types,adapters): EngineSupports 표면 + bootstrap 상태 모델 최소 (A02/A05)`

---
## Phase 4: batch 표면 + 등록 정리 + 문서·증거 정합

### Task 13: A04 — allSettled 형태 opt-in batch API

**Files:**
- Create: `packages/types/src/global-batch-settled.ts`
- Modify: `packages/types/src/index.ts` (export)
- Modify: `packages/types/src/public.ts` (타입)
- Test: `packages/types/src/index.test.ts`

**설계:** 기존 `invokeBatch`의 reject·순서·fail-fast 정책은 **무변경**. 별도 opt-in 함수만 추가:

```ts
export type BatchSettledEntry<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'unexecuted' };   // 실패한 항목 이후 실행되지 않은 것 — 실패≠미실행 구분

export function invokeBatchSettled<T>(entries: BatchEntry[]): Promise<Array<BatchSettledEntry<T>>>;
```

- 실행 정책: 기존 per-entry 폴백과 동일한 **순차 실행** — 항목 i가 reject하면 이후 항목은 `unexecuted`. (fail-fast가 기존 정책이므로 allSettled여도 계속 실행하지 않는다 — "실행됐지만 실패"와 "실행 안 됨"의 구분이 이 API의 핵심 가치.)
- 결과 순서 = entry 순서 보장. timeout·취소로 **결과 불명**인 경우는 존재하지 않는다(per-entry deadline이 결정적으로 reject되므로) — reject reason으로 판독.
- wire batch 단일 횡단 경로와의 조합: transport가 `invokeBatch`를 지원해도(원자적 all-or-nothing 의미) settled 표면은 **항상 per-entry 폴백으로 실행**한다 — 부분 성공 관측이 목적이므로. 이 선택을 JSDoc에 명시.

**Step 1: 실패 테스트** — ① 중간 실패: 앞 항목 fulfilled + 해당 rejected + 뒤 항목 unexecuted + 실행 횟수·순서 식별. ② 빈 batch → `[]`. ③ signal 혼합. ④ 전부 성공 → 전부 fulfilled. ⑤ 동일 입력 invokeBatch와 병행 — 기존 reject 계약 무변경 회귀.
**Step 2: FAIL → 구현 → PASS.** **Step 3: 커밋** `feat(types): invokeBatchSettled — 부분 성공·미실행 구분 표면 (A04)`

---

### Task 14: A07 — profiled dispatch 등록 분리

**Files:**
- Modify: `crates/rustra/src/tauri_support.rs` (`register`의 generate_handler에서 `rustra_dispatch_profiled` 제거, `register_profiled` 신설 또는 feature 게이트)
- Modify: `examples/tauri-calculator/src/benchmark.ts` 및 관련 bench host 설정 (`register_profiled` 경로 사용)
- Test: `examples/tauri-calculator/src-tauri/tests/` (등록 노출 검증)

**설계:** `register()`는 `rustra_dispatch`+`rustra_dispatch_batch`만. 벤치용은 `register_profiled()`를 별도 공용 함수로 제공(삭제가 아니라 분리 — 기존 symbol은 유지, "이미 소비하는 공용 API" 보호. Tauri invoke는 handler 목록에 있어야만 도달 가능하므로 production 등록에서 빠지면 노출이 꺼진다).

**Step 1: 실패 테스트** — ① `register()`로 빌드한 mock app에서 `rustra_dispatch_profiled` invoke → not-found 에러. ② `register_profiled()`로 빌드 → 정상. ③ 일반 `rustra_dispatch`는 양쪽 모두 정상(성능 무영향).
**Step 2: FAIL → 구현 → PASS.** **Step 3: bench 예제가 `register_profiled` 사용하도록 갱신** + `cargo test` 전체. **Step 4: 커밋** `refactor(rustra): profiled dispatch 등록 분리 — production 기본 노출 제거 (A07)`

---

### Task 15: A03/A17/A18 — 수동 검증 체크리스트 + reference 여정 + 증거 수준 명시

**Files:**
- Create: `docs/verification-checklist.md` + `.ko.md`
- Modify: `examples/calculator/tests/` (여정 통합 테스트 확장 — 자동화분)
- Modify: `README.md` + `README.ko.md` (증거표 — "manual checklist" 링크 추가)
- Modify: `docs/compatibility-matrix.md`+ko (미검증 플랫폼 수준 반영)

**자동화분 (A17):** calculator의 기존 7개 테스트 중 `runtime-contract`/`generated-client`를 확장해 **한 흐름 여정** 구성: invoke 성공 → 이벤트 구독+수신 → 장기 작업 진행 이벤트 → 취소 → 구독 해제 → 오류 복구 → dispose. Node loop-stdio 실호스트 위에서 실행(기존 test:ts:node에 연결).

**수동 체크리스트 문서 (A03 — 이 환경 불가분):**
1. Tauri 실제 WebView: R01(콜백 1회), R02(한글 이벤트 발행→구독), R03(payload 타입·값), Task 14(production 등록에서 profiled 미노출) — `examples/tauri-calculator`를 macOS에서 `bun run test:runtime:tauri` + 수동 실행.
2. RN 실호스트: 문자열·primitive·Unicode 이벤트, listener 예외, unsubscribe/re-subscribe — `examples/react-native-calculator` (실기기는 1.0 트랙, 시뮬레이터 수준 명시).
3. 등록 전 emit/구독 후 emit/unsubscribe 후 emit/reload 직후 늦은 emit 정책 확인.
4. A09 범위: RN 실기기에서 cancel·teardown 후 ownership 이상 무여부 관찰 (sanitizer는 별도 — 기록만).
5. A11 준비: 발행 승인 후 registry consumer 실행 절차 (실행은 하지 않음 — 절차만 문서화).
각 항목에 host·OS·빌드 종류·SHA·결과 기록 칸 포함(A03 완료 기준 형식).

**A18:** README 증거표에 "수동 체크리스트 실행 여부" 열 대신 링크를 추가하고, "Build-only/Simulator/Physical" 수준 구분이 현재 표에 이미 존재하는지 확인해 간격만 메운다(새 주장 금지).

**Step 1: 자동화 여정 확장 (TDD — 실패 케이스: 취소 후 구독 해제 흐름 미커버).** **Step 2: PASS.** **Step 3: 체크리스트 문서 작성(en+ko — [[docs-en-ko-pairing]] 규칙).** **Step 4: 커밋** `test(calculator): 통합 여정 테스트 + docs: 호스트 검증 수동 체크리스트 (A03/A17/A18)`

---

### Task 16: A10/A12/A13 + F01 최소 + changeset + 전면 게이트

**Files:**
- Modify: `README.md`+`README.ko.md` (A12 비교표 근거, A13 wire 명칭 정리)
- Create: `docs/wire-format.md` + `.ko.md` (A13 — rkyv V2 명칭 vs postcard codec 구분)
- Modify: `docs/benchmarks.md`+ko, `scripts/` 벤치 receipt 생성부 (F01 — receipt에 source SHA/artifact 식별자 필드 추가)
- Create: `.changeset/stabilization-unified.md`
- Modify: `Cargo.toml` — **수정하지 않는다** (Rust 0.5.0 bump는 발행 절차 — A10 문서에서 명시만)

**A12:** README.md:32의 napi-rs "manual d.ts" 셀을 공식 문서 기준으로 정정 — "TypeScript definitions generated from Rust structs (attributes)" 수준으로. 각 셀에 확인 기준일·참조 링크를 각주로. Rustra 우위 표현은 multi-host 계약·검증 관리로 재배치. **확인 날짜(2026-09-05)와 출처를 문서에 남긴다.**

**A13:** 신설 `docs/wire-format.md`:
- "rkyv V2"는 Rustra 자체 프레임/프로토콜 이름이고, payload codec은 postcard(manifest/dispatch 경로)다 — upstream rkyv 아카이브 포맷과의 호환은 별도 검증 없이 동일하다고 표기하지 않는다.
- "zero-copy"의 실제 범위: 어느 경계의 copy/allocation을 없애는지(Bun `toArrayBuffer` 뷰 등 실측 사례 참조) 명시 — 전체 RTT 의미로 확대 금지.
- 11.8×/47B 사례: payload 요청 wire 기준, 측정 경로·분모 명시. bytes/core dispatch/FFI/RTT 구분 표.
README의 "rkyv V2 (11.8× smaller)" 표현은 wire-format.md로 링크 + "(request wire vs JSON, see wire-format)" 수준으로 정밀화.

**F01 최소:** 벤치 receipt JSON 생성 스크립트에 `sourceSha`(git rev-parse), `nativeArtifact`(존재 시 식별자) 필드 추가 — 기존 receipt 재생성 없이 이후 receipt부터. 기존 receipt에 소급 주입하지 않는다.

**A10:** README 설치 스니펫은 dx 트랙이 0.6으로 고침(선머지로 반영됨). 잔여: "검증된 조합" 짧은 절 — README 또는 docs/compatibility-matrix에 "npm 0.6.x ↔ Rust crate 0.5.x (workspace) 조합이 현재 CI 검증 조합; crates.io bump는 발행 절차에서" 한 문단. 새 조합표 만들지 않음(YAGNI — 발행 시 갱신).

**Step 1: A12/A13 문서 작성(en+ko).** **Step 2: F01 receipt 필드 스크립트 수정 + 기존 receipt 테스트 회귀 확인.** **Step 3: A10 문단.**
**Step 4: changeset 작성:**

```md
---
'@rustra/cli': minor
'@rustra/types': minor
'@rustra/tauri': minor
'@rustra/node': minor
'@rustra/bun': minor
---

안정화 통합: generated 헤더 형식 판정(CI 근원 수정), Tauri 이벤트 콜백 경계·채널명 Unicode 통일·payload 단일 파싱,
wire batch 계약 통일(옵션·정규화·동기 throw), dispatch 중 abort 관측, native cancel 예외 분리,
bootstrap 단일 슬롯 가드, EngineSupports 표면, invokeBatchSettled.
```

(Rust crate 변경 — tauri_support.rs/builder_events.rs —는 npm changeset 불가: 커밋 메시지로 crates.io 발행 시 반영 명시. 기존 관례.)

**Step 5: 전면 게이트**

```bash
bun test packages/testing packages/types packages/react packages/node packages/bun packages/tauri packages/cli packages/react-native
cargo test -p rustra-naming -p rustra -p rustra-macros
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
bun run lint && bun run format:check
bun run test:docs && bun run test:onboarding
bun run test:ts:node && bun run test:adapter:tauri
```

**Step 6: 적대적 재검증 (검증 4계율):**
1. 헤더: 임의 생성물의 package.json에 수동으로 헤더 주입 → autolink red 확인 → 원복.
2. R01: tauri-events.ts를 원래 try-합침으로 임시 되돌림 → 신규 테스트 red → 원복.
3. R05: listener 재검사 제거 → red → 원복.
4. A04: unexecuted 판정 임시 제거 → red → 원복.

**Step 7: 커밋** `docs: 비교표·wire 명칭·증거 조합 정리 + bench receipt 식별자 필드 (A10/A12/A13/F01)` + `chore(changesets): 안정화 통합 트랙 changeset 적립`

---

### Task 17: changeset-release/main 로컬 머지 (푸시 전 사용자 확인)

**Step 1:**

```bash
git checkout changeset-release/main
git merge --no-ff feat/stabilization-unified -m "merge: 안정화 통합 트랙 — CI 복구+이벤트 3결함+코어 계약+지원 표면"
```

**Step 2: 머지 후 게이트 재확인** (핵심 패키지 bun test + cargo clippy + test:docs).

**Step 3: 푸시·CI 재검증(CI01/A01 실증)·발행은 사용자 승인 게이트** — 머지 결과를 보고하고 정지. `changeset version` 실행 금지.

---

## 테스트 전략

**단위 (TDD 각 태스크):** 위 각 Task의 Step 1 실패 테스트가 곧 목록. 통합 문서 8.1의 관찰값을 **기대값으로 쓰지 않는다** — 모두 올바른 기대값의 regression test로 작성(문서 지시 준수).

**통합:** T01~T07, T09, T10은 TS+Rust 자동화 커버. T02 golden fixture는 Rust/TS 양측 리터럴 공유. T13/A04는 settled API 테스트. T24(게이트 fault-injection)는 논리 유닛 테스트+푸시 후 실증.

**수동 (체크리스트로 문서화):** T03(실제 WebView), T08·T20(native), T12·T19·T26·T27(실부하·실기기 — 보류 항목과 연결), T21(발행 후), T17(격리 필요 시).

## 마이그레이션·호환성 참고

- R02 채널명: 신규 유실 없음(기존에도 JS-Rust 불일치로 유실 상태) — 커밋 메시지에 판정 기록.
- R03 payload: 문자열 내용 자동 추론 제거 → 문자열 payload를 "JSON처럼 생겼는데" 파싱하던 사용자 코드에 영향 가능. JSDoc+가이드 명시(통합 문서 3.4 — fail-loud보다 명시적 계약).
- R08 loud-fail: 기존 단일 bootstrap 사용자는 무영향, 이중 등록은 기존에도 조용한 오동작이었으므로 개선.
- profiled 등록 분리: bench 워크플로 소비처 1건 갱신 — 공용 symbol 자체는 유지.

## 명시적 범위 밖 (이번 사이클)

- A06(위협 모델), A08(overload 계측), A09(실행 검증), A11(실행), A14 잔여(quickstart CI), A15/A16(P3), F02/F03(실기기)
- Tauri 채널 어댑터 트랙 통합 — 별도 사용자 결정 유지
- `changeset version` 실행, push, PR 머지, npm/crates.io 발행 — 전부 사용자 게이트
- Rust workspace 버전 bump — 발행 절차 단계

## 참고 자료

- 통합 문서: 사용자 제공 "Rustra 안정화 및 개선 통합 문서" (2026-09-05)
- 리서치: `docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md`
- 선행 트랙: `docs/plans/2026-09-03-readiness-tracks.md`, `docs/plans/2026-09-04-dx-friction-track.md` (dx는 Task 0에서 선머지)
- CI 실패 로그: run 33776685582 (typescript/rn-ios/rn-android failure + 로컬 재현)




