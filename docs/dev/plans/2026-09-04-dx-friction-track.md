# DX 마찰 제거 트랙 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** DX 감사 리프레시(2026-09-04)가 확정한 "조용한 성공/조용한 실패" 마찰 HIGH 7건 + MEDIUM 2그룹을 해소하고, 온보딩 게이트를 E2E 첫성공 전 사이클로 확장하며, "발행 전 DX 감사 리프레시"를 상시 리듬으로 명문화한다.

**Architecture:** 워크트리 `.worktrees/dx` + 브랜치 `feat/dx-friction-track`, 베이스 `changeset-release/main` (bd72610b — readiness 트랙과 동일 베이스로 격리). TDD로 트랙별 커밋 그룹 순차 착지 → 전면 게이트 → 사용자 승인 게이트(푸시/머지). 로컬 `changeset version` 실행 없음.

**Tech Stack:** TypeScript (bun test + node:test), Rust (cargo test/clippy), changesets, codegen 듀얼 경로 재생성(Rust bin + TS CLI).

**설계 문서:** `docs/plans/2026-09-04-dx-friction-track-design.md`
**근거 리서치:** `docs/research/2026-09-04-dx-friction-audit-refresh.md`

**워크트리 경로 주의:** 이 계획의 모든 경로는 `/Users/loopy/dev/ll3/rustra-bridge/.worktrees/dx/` 안에서 실행한다. 메인 디렉터리와 `.worktrees/readiness`는 다른 작업 진행 중 — 절대 건드리지 않는다.

---

## 조사로 확정된 사실 (계획의 앵커)

1. **스캐폴드 `codegen:check` 항상 실패**: `packages/cli/src/init-template.ts`의 generateRs bin이 `generated/schema.json` 고정 경로에 쓰고 `RUSTRA_SCHEMA_OUT`을 무시 (주석: 발행 rustra에 `write_schema_to_dir`이 없어서의 의도적 절충). `cli-codegen.ts:78`이 check 모드에서 `RUSTRA_SCHEMA_OUT=checkRoot` env 주입 → `:90-95`에서 tmp 경로 schema.json 부재 시 throw.
2. **발행 rustra API 확인 필요**: 코어의 `write_schema_to_dir`가 발행됐는지(0.6.0/0.7.0)는 crates.io 확인이 어우면 Task 1 Step 1에서 `crates/rustra/src/package_types.rs` + 발행 릴리즈 노트로 판정. **미발행이면 옵션 (b) 고정** — 스캐폴드 generateRs가 `RUSTRA_SCHEMA_OUT` env를 `std::env::var`로 직접 읽어 존중하는 3줄 수정(발행 API 불필요).
3. **Next steps**: `packages/cli/src/cli-init.ts:107-112` — `cd → bun install → bun run codegen → bun run demo → cargo run`. `cargo build` 누락.
4. **positional facade**: `packages/cli/src/generate-positional.ts:97-112` — 3개 렌더 경로 모두 `void options;` 후 `Promise.resolve(callPos(...))`. 동기 throw: `callPos`/`call`/`requireNative`(`generated/positional-facade.ts:27-52`)이 프로미스 생성 전에 throw.
5. **에러 정규화 대상**: `packages/types/src/cancel.ts:34,52,62,90,105,120` / `cancel-by-id.ts:14,32,43` / `global-batch.ts:44` / `cancel-abort.ts:10` — 전부 `new RustraCommandError('cancelled'|timeout...)`. 서브클래스 `TimeoutError`/`CancelledError`는 `errors.ts:26-42`에 이미 존재. `global-config.ts:70-71`(invoke reject plain Error) vs `:87`(invokeGenerated 동기 throw) 불일치.
6. **capability 무음 드랍**: `macro_register.rs:60-95` — register!/build!가 `.command().command_doc().require_capability_if()` 체인으로 meta/doc/cap 상수 소비. `.command_fn()`(`builder_commands.rs:87-95` 이름추론) 경로는 이 체인을 거치지 않아 `__RUstra_cap_*` 상수 소비처 없음. 매크로는 `macro_command.rs:115-127`에서 cap 상수를 무조건 생성.
7. **onboarding 게이트 테스트**: `scripts/onboarding-gate.test.ts` — runner 주입 패턴 4테스트 존재. `ONBOARDING_STEPS` export가 단계 정의.
8. **문서 드리프트 위치**: `docs/getting-started.md:208,828-832`(generate bin 서술) / `:541-563`(마커 밖 샘플·해시) / `README.md:709` / `README.md:545`(i64→number 표) / 버전 스니펫 3중 갈라짐(`README.md:147,565` 등 `rustra = "0.4"`). calculator 실제 bin은 `src/bin/{loop-stdio,wire-bench}.rs`뿐 — `generate` bin 부재.
9. **generated/ 재생성 관례**: Rust bin + TS CLI 둘 다 (`codegen-dual-path` 관례), generated/는 prettier 제외.
10. **changeset 관례**: 신규 착지는 `.changeset/`에 적립만 — version 실행 없음.

---

### Task 0: 워크트리 생성 + 베이스라인

**Files:** 없음 (환경만)

**Step 1: 워크트리 생성**

```bash
cd /Users/loopy/dev/ll3/rustra-bridge
git worktree add .worktrees/dx -b feat/dx-friction-track bd72610b
cd .worktrees/dx && bun install --frozen-lockfile
```

**Step 2: 베이스라인 게이트**

```bash
bun test packages/cli packages/types scripts/onboarding-gate.test.ts
bun run test:docs
```

Expected: 전부 PASS. red가 있으면 착지 전에 먼저 보고.

---

### Task 1: 스캐폴드 codegen:check 계약 정합 (감사 #1)

**Files:**

- Modify: `packages/cli/src/init-template.ts` (generateRs 템플릿 문자열)
- Test: `scripts/onboarding-gate.test.ts` (스캐폴드 generateRs가 RUSTRA_SCHEMA_OUT 존중 검증)

**Step 1: 발행 API 판정**

`crates/rustra/src/`에서 `write_schema_to_dir` 존재 + 발행 여부 확인. **미발행(옵션 b) 기준으로 진행** — generateRs 템플릿이 env를 직접 읽게 수정:

```rust
// generateRs (init-template.ts 내 문자열) — RUSTRA_SCHEMA_OUT이 있으면 그 경로에,
// 없으면 generated/schema.json 에 기록. `rustra codegen --check`의 check-mode 계약과 정합.
use std::path::PathBuf;

fn main() -> rustra::Result<()> {
    let generated = rustra_app::package().generate_typescript()?;
    let out = match std::env::var("RUSTRA_SCHEMA_OUT") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            std::fs::create_dir_all("generated")?;
            PathBuf::from("generated").join("schema.json")
        }
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, &generated.schema_json)?;
    println!("{} written", out.display());
    Ok(())
}
```

**Step 2: 실패하는 테스트 먼저** — `scripts/onboarding-gate.test.ts`에 추가:

```ts
test('scaffold generate bin honors RUSTRA_SCHEMA_OUT (codegen:check contract)', () => {
  // init-template의 generateRs가 env를 읽는지 — 스캐폴드 소스 자체를 계약으로 검증.
  const { renderInitProjectFiles } = await import('../packages/cli/src/init-template.js');
  const files = renderInitProjectFiles(
    { cargoRange: '0.5', npmCliCaret: '^0.6.0', npmTypesRange: '^0.6.0' },
    { reactNative: false },
  );
  // 정확한 접근 방식은 InitProjectFiles 반환형 실측 후 확정 — generate.rs 내용에
  // `RUSTRA_SCHEMA_OUT` 문자열 존재 + 고정 경로 단독 write 금지를 assert.
});
```

Run: `bun test scripts/onboarding-gate.test.ts` → FAIL (현재 템플릿은 env 무시).

**Step 3: generateRs 템플릿 수정 + PASS.**

**Step 4: E2E 검증** — 임시 디렉터리에서 init → codegen → `codegen --check` 성공 확인 (게이트가 실동행 커버하므로 `bun run test:onboarding`으로 대체 가능하면 그게 최선).

**Step 5: 커밋** `fix(cli): 스캐폴드 generate bin이 RUSTRA_SCHEMA_OUT 존중 — codegen:check 계약 정합`

---

### Task 2: init Next steps 보완 + doctor 도달성 검사 (감사 #4 + #9 후반)

**Files:**

- Modify: `packages/cli/src/cli-init.ts:107-112` (Next steps)
- Modify: `packages/cli/src/doctor-checks.ts` (crates.io 도달성 검사 신설)
- Modify: `packages/cli/src/cargo-metadata.ts:52-57` (ENOENT 시 설치 힌트)
- Test: 각 파일 인접 테스트 관례 확인 후 추가

**Step 1: 실패 테스트** — Next steps 출력에 `cargo build` 포함 assert (기존 init 테스트 파일에서 출력 캡처 패턴 확인).

**Step 2: Next steps 수정:**

```ts
console.log('\nNext steps:');
console.log(`  cd ${directories[0]}`);
console.log('  cargo build   # first build takes a few minutes (deps download)');
console.log('  bun install');
console.log('  bun run codegen');
console.log('  bun run demo');
```

(`cargo run`은 demo 후 실사용 단계로 유지 판단 — 실행하며 확인.)

**Step 3: doctor crates.io 도달성 검사** — 기존 doctor-checks 패턴(검사 항목 구조) 준용:

- 검사명 `registry.reachability`, 상태는 **warn 수준** (네트워크 단절이 fail인 CI 환경 보호 — fail-closed 하면 CI 전반 red).
- 방법: `cargo metadata`가 이미 cargo를 필요로 하므로, cargo 존재 시 `cargo search` 대신 경량 HEAD(`https://index.crates.io/config.json` fetch with timeout 3s). fetch 실패+오프라인 env 아니면 warn + "cargo build may fail if crates.io is unreachable (proxy?)" 힌트.
- 테스트: fetch 결과 주입 패턴으로 pass/warn 분기.

**Step 4: cargo ENOENT 힌트** — `cargo-metadata.ts`의 spawnSync 에러 코드 ENOENT 분기 시 메시지에 `rustup` 설치 안내 1줄 추가 (doctor 직행이 아닌 codegen 경로 커버).

**Step 5: PASS + 커밋** `fix(cli): init Next steps에 cargo build 보완 + doctor registry 도달성 검사 + cargo ENOENT 힌트`

---

### Task 3: 온보딩 게이트 E2E 사이클 확장 (컴포넌트 A)

**Files:**

- Modify: `scripts/onboarding-gate.mjs` (ONBOARDING_STEPS + commandFor + 검증 로직)
- Test: `scripts/onboarding-gate.test.ts`

**Step 1: 실패 테스트** — runner 주입 패턴으로:

```ts
test('gate runs the full first-success cycle: … → demo → mutate → regen → verify', ...)
// mutate 단계 커맨드가 프로젝트 디렉터리에서 실행되는지
// verify 단계가 생성물에 신규 필드를 요구하는지
```

**Step 2: 게이트 확장 구현:**

- `ONBOARDING_STEPS`에 3단계 추가: `{ name: 'mutate' }`, `{ name: 'regen' }`, `{ name: 'verify' }`.
- `commandFor`에 3케이스 추가:
  - `mutate`: 스캐폴드 lib.rs에 파라미터 1개 추가하는 안전한 변형 — 텍스트 치환 스크립트(node -e) 또는 gate가 직접 fs 수정 후 `{ cwd: projectDir, argv: ['true'] }`(no-op 커맨드 — 실제 변형은 gate가 fs로 수행하는 방식이 테스트와 양립이 낫다. **gate가 fs로 직접 수행 + verify가 그 결과를 검증**하는 구조 권장).
  - `regen`: `commandFor('codegen', ...)` 재사용.
  - `verify`: gate가 생성 `commands.ts`/`types.ts`에 신규 필드 존재 + 데모 재실행(`bun run demo`)으로 왕복 검증.
- 단계별 `durationMs` 측정·출력 (`runOnboardingSteps` 루프에서 Date.nowdiff 수집 — 보조 지표 1의 측정 기반).

**Step 3: PASS + 적대적 재검증** — verify의 필드 검증을 일부러 어기는 변형(예: gate 코드에서 검증 대상 필드명을 존재하지 않는 것으로) → `bun run test:onboarding` red 확인 → 원복 → green.

**Step 4: 커밋** `feat(cli): 온보딩 게이트 E2E 사이클 확장 — mutate/regen/verify + 단계 타이밍`

---

### Task 4: stale 런타임 바이너리 힌트 + freshness 정합 (감사 #3)

**Files:**

- Modify: `packages/cli/src/cli-codegen.ts` (성공 출력 끝 힌트)
- Modify: `packages/cli/src/doctor-checks.ts` (`codegen.generated_freshness`에 런타임 바이너리 해시 정합 추가 — 가능 범위 판단 후)
- Test: 인접 테스트 관례

**Step 1: 실패 테스트** — codegen 성공 출력에 "runtime binary" 힌트 포함 assert (format=json 모드가 아닌 텍스트 모드).

**Step 2: 힌트 구현** — codegen 성공 출력末:

```
[rustra] Note: the runtime binary (target/debug/rustra-app) was not rebuilt by codegen.
Run `cargo build` before invoking so the native side matches the new schema.
```

(조건부 — 스키마가 이전과 달라졌을 때만 출력하면 소음 없음. `runGenerate`의 drift 정보 재사용 판단.)

**Step 3: doctor freshness 확장 판단** — contract.ts 해시 vs `target/*/rustra-app` 실바이너리 정합은 빌드 산출물 파싱이 필요해 과할 수 있음. **최소 컷**: doctor의 freshness 검사가 프로브(generate bin 산출 schema) 기준이라는 한계를 검사 결과 텍스트에 명시 + codegen 쪽 힌트가 실질 커버. (바이너리 해시 대조는 과하면 하지 않는다 — YAGNI, 실행 중 판단 후 기록.)

**Step 4: PASS + 커밋** `fix(codegen): stale 런타임 바이너리 경고 힌트 — demo contract.mismatch 조기 진단`

---

### Task 5: positional facade options 정합 + rejected Promise 정규화 (감사 #6/#7)

**Files:**

- Modify: `packages/cli/src/generate-positional.ts` (렌더러 3경로)
- Test: `packages/cli` 인접 테스트 + 생성물 스모크
- Regen: `examples/calculator/generated/positional-facade.ts` (듀얼 경로 관례)

**설계 결정:** options 미지원을 "시그니처 제거"로 하면 기존 소비자 호환 breaking(단, positional facade 자체가 최신 생성물이라 소비자 실재 여부 확인 — generated 헤더가 신규라 실사용 소비자 0일 가능성 높음). **옵션을 유지하되 전달 구현이 정답** — `call`/`callPos`에 options를 넘겨 `invokeTypedPos(cmdId, ...fields, options)` 형태가 가능한지 네이티브 시그니처 확인 필요. 불가하면:

- options를 받는 오버로드 제거 + 시그니처에서 `options?: InvokeOptions` 삭제 (breaking이지만 생성물은 재생성 필수 자산이라 허용 범위) + changeset에 명시.

**Step 1: 네이티브 시그니처 확인** — `packages/types` 또는 RN 쪽 `invokeTypedPos`/`invokeTyped`가 options를 받는지 실측. (crates/rustra의 JSI/FFI 진입도 확인.)

**Step 2: 실패 테스트** — 렌더러 출력 스냅샷/문자열 검증:

- options 전달 가능 판정 시: 생성 코드가 `options`를 무시하지 않고 전달하는지 (`void options` 부재).
- 불가 판정 시: 시그니처에 options 부재.

**Step 3: 동기 throw 정규화** — `call`/`callPos`/`requireNative` throw 지점을 async 컨텍스트로:

```ts
// 생성 템플릿 내 — 헬퍼를 async 함수로 바꿔 rejected Promise 계약 일치
async function call<T>(...): Promise<T> {
  const native = requireNative();       // throw 여기서 발생해도 async라 rejected Promise가 됨
  ...
}
```

`requireNative` 자체는 동기 유지(다른 소비처 확인 후) — 렌더러가 생성하는 호출 경로만 async 화. **테스트**: `addNumbers(1,2).catch(...)` 패턴이 uncaught exception 없이 catch에 도달하는지 (node 환경에서 생성물 스모크).

**Step 4: 생성물 재생성** — 듀얼 경로 관례로 calculator 재생성 + `bun test examples/calculator`(존재 시) 또는 스모크.

**Step 5: PASS + 커밋** `fix(codegen): positional facade options 계약 정합 + rejected Promise 정규화`

---

### Task 6: 타임아웃/미구성 에러 정규화 (감사 #8)

**Files:**

- Modify: `packages/types/src/cancel.ts` (6곳), `cancel-by-id.ts` (3곳), `global-batch.ts` (1곳), `cancel-abort.ts` (1곳)
- Modify: `packages/types/src/global-config.ts:70-71,87` (미구성 오류 통일)
- Modify: `packages/types/src/json-engine.ts` + 타임아웃 race 지점 (grep `transport.timeout` 전수)
- Test: `packages/types/src/index.test.ts`

**Step 1: 실패 테스트:**

```ts
// ① 타임아웃 race → TimeoutError 인스턴스
// ② 취소 경로 전부 → CancelledError 인스턴스 (cancel/cancel-by-id/global-batch/cancel-abort)
// ③ 미구성 invoke → rejected Promise + RustraCommandError('transport.unavailable')
// ④ 미구성 invokeGenerated → 동기 throw가 아니라 rejected Promise (계약 통일)
// instanceof 분기 테스트는 각 경로별 실제 엔진 주입 패턴 기존 테스트 참고
```

**Step 2: 구현** — `new RustraCommandError('cancelled', ...)` → `new CancelledError(...)` (코드 매핑 동일 — 서브클래스가 이미 같은 코드 사용). 타임아웃 race 지점도 `TimeoutError`로. 미구성 경로:

```ts
// global-config.ts — 두 경로 모두
return Promise.reject(
  new RustraCommandError(
    'transport.unavailable',
    'Rustra not configured. Call configure(engine) first.',
  ),
);
```

(`transport.unavailable` 코드 존재 여부는 `RustraErrorCode` 실측 — 없으면 가장 가까운 기존 코드 재사용, 신규 코드 추가는 와이어 계약이므로 피한다.)

**Step 3: PASS + `bun test packages/types` 전체 회귀 확인.**

**Step 4: 커밋** `fix(types): 타임아웃/취소/미구성 에러 서브클래스·계약 통일 — 경로별 instanceof 일치`

---

### Task 7: capability 무음 드랍 제거 (감사 #5)

**Files:**

- Modify: `crates/rustra-macros/src/macro_register.rs:60-95` (또는 대응 위치 — cap 상수 미소비 감지)
- Modify: `crates/rustra/src/builder_commands.rs` (command_fn 경로 — 대안 구현 위치)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs` (기존 관례 파일)

**설계 결정 (실행 중 확정):** 감지 위치는 두 가지 —

- (a) 매크로 차원: `#[command(capability=...)]`이 붙은 fn이 register!/build!로 등록되는 것은 토큰 차원에서 알 수 없음(매크로 경계) → (a) 불가.
- (b) **런타임 차원**: `__RUstra_cap_*` 상수가 `Option<&str>::Some`인데 `.command_fn()`으로 등록되면 패닉. 구현: builder에 `register_command_with_capability` 내부 경로 추가하거나, 더 단순하게 — `macro_command.rs`가 생성하는 상수를 `#[used]`+링크 섹션이 아니라, **`.command_fn()`이 이름추론으로 등록 시 해당 fn 이름의 cap 상수를 검사할 수 없으므로**, 역방향: **`.command_fn` 문서화+컴파일 타임 감지 불가를 인정하고, capability가 Some인 fn에 대해 `.command_fn` 사용 자체를 막는 것** — `#[command(capability=...)]`이 있으면 매크로가 **원본 fn을 consume하는 별도 등록 헬퍼만 남기고** 이름추론 등록 시 컴파일 에러(`compile_error!`)가 나게 상수를 심는 방식.

실행 시점에 (b)의 정확한 메커니즘을 확정한다. 최소 계약: **capability 지정 fn이 capability 없이 등록되는 것은 컴파일 에러 또는 등록 시 패닉 — 조용한 공개 명령화 금지.**

**Step 1: 실패 테스트** — `#[command(capability = "x:secure")] fn f()` + `.command_fn(f)` 등록이 "capability silently dropped" 에러로 실패함을 assert (trybuild 관례 있으면 그걸로, 없으면 런타임 패닉 테스트).

**Step 2: 구현 + PASS.**

**Step 3: wire round-trip 게이트** — `cargo test -p rustra` 전체 + capability 관련 기존 테스트 회귀 확인 (calculator의 `secure_compute`는 수동 `.require_capability` 경로 — 영향 없음 확인).

**Step 4: 커밋** `fix(macros): capability 무음 드랍 제거 — command_fn 경로 계약 강제`

---

### Task 8: 문서 실동행 정합 + 마커 밖 드리프트 소거 (감사 #2/#10)

**Files:**

- Modify: `docs/getting-started.md:208,828-832` + `.ko.md` 대응 (generate bin 서술 — Task 1 결과 반영: env 존중 방식으로 정합)
- Modify: `examples/calculator` 프로브 재생성 경로 확정 — calculator에 `generate` bin이 없으므로:
  - 옵션 (a): `examples/calculator/src/bin/generate.rs` 신설 (스캐폴드와 동일 계약 — RUSTRA_SCHEMA_OUT 존중) + 문서는 그대로 유효
  - 옵션 (b): 문서를 실제 경로(loop-stdio.rs의 `__rustra_contract` 핸드셰이크)로 정정
  - **(a) 권장** — 문서가 가르치는 명령이 실제로 동작하게 + 스캐폴드와 동일 패턴의 일관성
- Modify: `docs/getting-started.md:541-563` (마커 밖 샘플·해시 실물 갱신 — 가능하면 docs:sync 마커 흡수) + `.ko.md`
- Modify: `README.md:545` 타입 표(`i64 → number | bigint`) + `README.ko.md:508`
- Modify: 버전 스니펫 정리 — `README.md:147,565` / `README.ko.md:129,527` / `docs/getting-started.md:44`(+ko) `rustra = "0.4"` → 현재 라인 통일 (0.7.0 발행 대기 상태 감안해 `rustra = "0.6"` + 발행 시 갱신 주석, 또는 docs-gate로 검증 가능한 형태 판단)
- Modify: `examples/calculator/README.ko.md:33` (폐기 write_to_dir 서술) + `README.md:38-46`·`getting-started.md:242` (생성 파일 7개 목록)
- Regen: calculator `generate.rs` 신설 시 generated/ 재생성 (듀얼 경로)

**Step 1: calculator generate bin 신설 (옵션 a)** — 스캐폴드 Task 1 결과와 동일 계약.

**Step 2: 문서 갱신** — 위 파일들. en+ko 쌍 유지 ([[docs-en-ko-pairing]]).

**Step 3: 실동행 검증** — 문서가 가르치는 명령 실제 실행: `cargo run -p rustra-calculator-example --bin generate` 성공 + `bun run test:docs` green.

**Step 4: 커밋** `docs: 프로브 재생성 경로 실동행 정합 + 마커 밖 샘플·타입표·버전 정정`

---

### Task 9: 상시 리듬 명문화 (컴포넌트 C)

**Files:**

- Modify: `docs/plans/2026-09-01-roadmap-design.md` "상시 실행 리듬" 절
- Modify: `README.md` 로드맵 절 + `README.ko.md` (en+ko 쌍)

**Step 1:** roadmap-design "상시 실행 리듬"에 1줄 추가:

```markdown
- 마이너 발행 전 DX 감사 리프레시 — 2026-08-29 감사 → 2026-09-04 리프레시의 2례가 원형.
  마찰 회귀는 게이트가 잡고(자동), 새 마찰은 감사가 발굴하고(수동 리듬), 수정은 트랙으로 쌓는다.
```

**Step 2:** README 로드맵(=계획/로드맵 섹션)에 동일 원칙 1줄(en/ko).

**Step 3:** `bun run test:docs` green + 커밋 `docs(plans): 상시 리듬에 발행 전 DX 감사 리프레시 명문화`

---

### Task 10: changeset 적립 + 전면 게이트

**Files:**

- Create: `.changeset/dx-friction-track.md`

**Step 1: changeset** — 착지 표면 최종 확정 후 (예상):

```md
---
'@rustra/cli': minor
'@rustra/types': minor
---

DX 마찰 트랙: 스캐폴드 generate bin이 RUSTRA_SCHEMA_OUT 존중(codegen:check 정합),
init Next steps 보완, doctor registry 도달성 검사, 온보딩 게이트 E2E 사이클
(mutate/regen/verify + 타이밍), stale 런타임 바이너리 경고, positional facade
options/async 계약 정합, 타임아웃/취소/미구성 에러 서브클래스 통일,
capability 무음 드랍 제거.
```

(positional facade 시그니처 제거 판정 시 `@rustra/cli`에 breaking 아닌 minor — pre-1.0 규칙 + 마이그레이션 노트 문구 포함.)

**Step 2: 전면 게이트**

```bash
bun test packages/cli packages/types packages/react packages/node
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo test -p rustra -p rustra-macros
bun run lint && bun run format:check
bun run test:docs && bun run test:onboarding
```

**Step 3: 적대적 재검증 총괄** — Task 3의 게이트 변형 red→green 재확인.

**Step 4: 커밋** `chore(changesets): DX 트랙 changeset 적립`

---

### Task 11: changeset-release/main 로컬 머지 (푸시 전 사용자 확인)

readiness 트랙과 동일 절차:

**Step 1:** `git checkout changeset-release/main && git merge --no-ff feat/dx-friction-track -m "merge: DX 마찰 트랙 — 게이트 확장+조용한 실패 제거+상시 감사 리듬"`

**Step 2:** 머지 후 게이트 재확인 (핵심 bun test + test:docs + test:onboarding)

**Step 3:** **푸시는 사용자 확인 후** — `changeset version` 실행 금지 (사용자 승인 시점에만). readiness 트랙과의 문서 충돌(roadmap-design 동시 수정 가능성)은 merge-tree 선검증.

---

## 명시적 범위 밖

- readiness 트랙 소관 전부 (NDJSON 보존, 응답 셰이프, thiserror 문서, 문서 정직성 4건, 코드 위생)
- 브랜치 통합(feat/tauri-channel-adapter-work 등) — 사용자 결정 보류
- 로컬 `changeset version` 실행/푸시 승인 — 사용자 게이트
- 큐잉: on_unimplemented 구현, bun 데모 다중화, CJS exports, CommandName 유니온, mock 출력 검증, dev --format json, vite 플러그인 문서, generate --format json shape, Windows 경로, 디버그 블라인드 스팟, useEvent JSDoc
- Electron/WASM/배치 항목별 취소 — 0.8
