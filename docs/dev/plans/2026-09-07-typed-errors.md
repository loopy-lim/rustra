# 커맨드별 타입화 에러 — 구현 계획 (2026-09-07)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

설계: `2026-09-07-typed-errors-design.md` / 리서치: `docs/research/2026-09-07-typed-error-codesgen.md`

**Goal:** Rust 커맨드에 "이 명령이 반환할 수 있는 도메인 에러 코드"를 선언하고(`command_errors` 빌더 + `#[command(error(...))]` 매크로), schema.json `"errors"` 필드로 흘려 `rustra codegen`이 커맨드별 리터럴 유니언 + 타입 가드(`isDivideError`)를 생성 — 경쟁 격차 #2("제네릭 `{code,message}` → string 비교 분기") 해소. **런타임 에러 계약(와이어/호스트/`RustraCommandError`)은 무변경.**

**Architecture:** platforms 필드 트랙(빌더→조건부 스키마 필드→메타 체인)과 events 섹션 트랙(선언→스키마→조건부 TS 파일)의 관례 조합. Rust는 schema.json까지만 발행(단일 화살 코드젠 — `write_schema_to_dir`, package_types.rs:150-168), TS 표면은 packages/cli가 렌더링. 에러 와이어 프레임(`[ok=0][pad][len u16][postcard{code,message}]`, rkyv_error.rs:12-17)·호스트 승격 지점·`@rustra/types` 런타임은 전부 무변경.

**Tech Stack:** Rust (crates/rustra, crates/rustra-macros), TypeScript (packages/cli).

---

### Task 1: `CommandErrorVariant` 타입 + `Command.error_variants` + `command_errors` 빌더

**Files:**

- Modify: `crates/rustra/src/error.rs` (`CommandErrorVariant` pub struct + const 생성자 + 코드 패턴 검증 헬퍼)
- Create: `crates/rustra/src/builder_errors.rs` (`command_errors` / `errors_meta_if`)
- Modify: `crates/rustra/src/builder.rs` (`include!("builder_errors.rs");` — builder_platform.rs와 동일 배치)
- Modify: `crates/rustra/src/command_types.rs` (`Command.error_variants: Vec<CommandErrorVariant>` 필드)
- Modify: `crates/rustra/src/command_build.rs` (`build_command` 기본값 빈 벡터)
- Modify: `crates/rustra/src/builder_platform.rs` (`platform_command_impl`의 스텁 교체가 `error_variants`를 보존 — `platforms` 보존 라인 옆에 1줄)
- Modify: `crates/rustra/src/prelude.rs` (`CommandErrorVariant` 재수출 — `Platform` 재수출 관례)
- Create: `crates/rustra/src/builder_errors_tests.rs`
- Modify: `crates/rustra/src/lib.rs` (`#[cfg(test)] mod builder_errors_tests;` — lib.rs:194 관례)

**Step 1: 실패 테스트 작성** — `builder_errors_tests.rs`:

```rust
use super::*;
use crate::CommandErrorVariant;

#[test]
fn command_errors_records_variants() {
    let package = Package::builder("example.errors")
        .command("divide", |input: Value| Ok(input))
        .command_errors(
            "divide",
            &[CommandErrorVariant::new("math.divide_by_zero")
                .describe("0으로 나눌 때")],
        )
        .build();
    // build 후 Command.error_variants 확인 경로: schema 엔트리로 단언(Task 2 전에는
    // 내부 상태 direct assert — commands BTreeMap 접근)
}

#[test]
#[should_panic(expected = "command_errors: command 'nope' is not registered")]
fn command_errors_panics_on_unknown_command() { … }

#[test]
#[should_panic(expected = "invalid error code")]
fn command_errors_panics_on_invalid_code_pattern() {
    // "Math/Divide" (대문자/슬래시) — ^[a-z][a-z0-9_.]*$ 위반
}

#[test]
#[should_panic(expected = "duplicate error code")]
fn command_errors_panics_on_duplicate_code() { … }

#[test]
#[should_panic(expected = "errors must not be empty")]
fn command_errors_panics_on_empty_slice() { … }
```

**Step 2: 실패 확인** — `cargo test -p rustra builder_errors` → 컴파일 실패(`CommandErrorVariant` 미존재).

**Step 3: 구현**

- `error.rs`: `CommandErrorVariant { code: &'static str, description: Option<&'static str>, retryable: bool }` + `const fn new/describe/retryable` + `pub(crate) fn validate_error_code(code: &str)`(정규식 대신 수동 스캔 — `^[a-z]` 시작, `[a-z0-9_.]` 연속; TS 파서 기준 errors.ts:71과 동일 집합).
- `builder_errors.rs`:

```rust
impl PackageBuilder {
    /// 커맨드에 에러 코드 선언을 추가한다. 선언은 schema.json "errors" 필드와
    /// TS 코드젠(타입 가드)의 원천 — 런타임 와이어는 무변경({code,message}).
    /// 패닉: 미등록 명령 / 빈 슬라이스 / 코드 패턴 위반 / 중복 코드.
    pub fn command_errors(mut self, name: &str, errors: &[CommandErrorVariant]) -> Self {
        let command = self.commands.get_mut(name)
            .unwrap_or_else(|| panic!("command_errors: command '{name}' is not registered"));
        if errors.is_empty() { panic!("command_errors('{name}'): errors must not be empty"); }
        for e in errors { /* validate_error_code + 중복 검사 */ }
        command.error_variants = errors.to_vec();
        self
    }

    /// #[command(error(...))] 메타데이터 연결 — None이면 no-op (platform_meta_if 관례).
    pub fn errors_meta_if(mut self, name: &str, errors: Option<&'static [CommandErrorVariant]>) -> Self { … }
}
```

- `command_types.rs` 필드 + `command_build.rs` 기본값 + `builder_platform.rs` 보존 1줄 + prelude 재수출.

**Step 4: PASS 확인** — `cargo test -p rustra builder_errors && cargo test -p rustra error`

**Step 5: 커밋** — `feat(core): CommandErrorVariant + command_errors 빌더 — 커맨드별 도메인 에러 코드 선언`

---

### Task 2: 스키마 `"errors"` 필드 (package_schema.rs)

**Files:**

- Modify: `crates/rustra/src/package_schema.rs` (`command_schema_entry`에 조건부 삽입)
- Test: `crates/rustra/src/builder_errors_tests.rs` (스키마 엔트리 단언 추가)

**Step 1: 실패 테스트 추가**

```rust
#[test]
fn schema_entry_includes_errors_when_declared() {
    // command_errors 선언 패키지의 schema() → commands[0]["errors"] ==
    // [{"code":"math.divide_by_zero","description":"0으로 나눌 때","retryable":false}]
}

#[test]
fn schema_entry_omits_errors_when_undeclared() {
    // 선언 없는 명령 엔트리에 "errors" 키가 없어야 한다(계약 해시 불변 —
    // platforms 관례 package_schema.rs:161-169와 동일)
}
```

**Step 2: 실패 확인** — `cargo test -p rustra schema_entry` → 첫 테스트 실패(키 부재).

**Step 3: 구현** — `command_schema_entry`에서 `if !command.error_variants.is_empty()`일 때 `errors` 배열 삽입. 원소는 항상 `code`/`description`/`retryable` 3키(description은 null 허용) — 설계 A절의 바이트 안정성. `command_wire_signature`는 같은 함수를 공유하므로 자동 정합(package_schema.rs:193-196).

**Step 4: PASS 확인** — `cargo test -p rustra && cargo test -p rustra --doc`

**Step 5: 커밋** — `feat(core): 스키마 명령 항목에 errors 필드 — 조건부 기록으로 기존 계약 해시 불변`

---

### Task 3: 매크로 `#[command(error(...))]` + register!/build! 체인

**Files:**

- Modify: `crates/rustra-macros/src/macro_command_support.rs` (`CommandAttr.errors: Option<Vec<String>>` + `error("a", "b")` 파싱 + 지원 키 안내 갱신)
- Modify: `crates/rustra-macros/src/macro_command.rs` (`__RUstra_errors_{fn}` const 방출 — `CommandErrorVariant::new(...)` const 체인)
- Modify: `crates/rustra-macros/src/macro_register.rs`, `crates/rustra-macros/src/macro_build.rs` (체인에 `.errors_meta_if(#meta_ident, #errors_ident)` 1줄씩)
- Test: `crates/rustra/tests/public_authoring_api_tests.rs` (capability/platform 매크로 사례 옆에 error 사례 추가)

**Step 1: 실패 테스트 작성** — `public_authoring_api_tests.rs`:

```rust
/// `#[command(error(...))]` — 커맨드별 도메인 에러 코드 선언을 매크로 시점에
/// 심는다 (register!/build! 가 errors_meta_if 로 연결).
#[command(error("math.divide_by_zero"))]
fn divide_typed_errors(input: DivideInput) -> Result<DivideOutput> { … }

#[test]
fn command_error_attr_declares_schema_errors() {
    let package = rustra::register!(Package::builder("example.attr"), divide_typed_errors).build();
    // schema() 의 해당 엔트리에 errors[0].code == "math.divide_by_zero" 단언
}
```

**Step 2: 실패 확인** — `cargo test -p rustra --test public_authoring_api_tests` → 컴파일 실패(unsupported `#[command]` key: `error`).

**Step 3: 구현** — `platform(...)` 파싱 구조(macro_command_support.rs:40-58)를 그대로 변주: 괄호 안 `LitStr` 목록, 최소 1개. const 방출:

```rust
const __RUstra_errors_divide_typed_errors: Option<&[rustra::CommandErrorVariant]> =
    Some(&[rustra::CommandErrorVariant::new("math.divide_by_zero")]);
```

`errors_meta_if`의 `Option` 시그니처가 선언 없는 `#[command]`와의 통일 체인을 유지한다(platform_meta_if 관례).

**Step 4: PASS 확인** — `cargo test -p rustra --test public_authoring_api_tests && cargo test -p rustra-macros`

**Step 5: 커밋** — `feat(macros): #[command(error(...))] 속성 — 도메인 에러 코드 선언을 체인에 자동 연결`

---

### Task 4: CLI 스키마 타입 + `errors.ts` 렌더러

**Files:**

- Modify: `packages/cli/src/schema.ts` (`CommandSchema.errors?: CommandErrorVariantSchema[]` + 타입 정의)
- Create: `packages/cli/src/generate-errors.ts` (`generateErrorsTs(schema)` 렌더러)
- Modify: `packages/cli/src/generate.ts` (re-export)
- Modify: `packages/cli/src/cli-generate-files.ts` (배터리에 조건부 추가 — events.ts 배선 cli-generate-files.ts:95-96 바로 옆)
- Test: `packages/cli/src/generate.test.ts` (또는 신설 `generate-errors.test.ts`)

**Step 1: 실패 테스트 작성**

```ts
import { describe, expect, test } from 'bun:test';
import { generateErrorsTs } from './generate-errors.js';

const schema = /* divide가 errors 1건을 선언한 최소 PackageSchema fixture */;

describe('generateErrorsTs', () => {
  test('선언 커맨드가 있으면 errors.ts를 생성한다', () => {
    const out = generateErrorsTs(schema);
    expect(out).toContain("export const DivideErrorCode = {");
    expect(out).toContain("MathDivideByZero: 'math.divide_by_zero'");
    expect(out).toContain('export function isDivideError(error: unknown): error is DivideError');
    expect(out).toContain("new Set(['math.divide_by_zero'])");
  });
  test('선언이 없으면 빈 문자열(파일 미생성 — events.ts 관례)', () => {
    expect(generateErrorsTs(schemaWithoutErrors)).toBe('');
  });
  test('PascalCase 키 충돌은 loud-fail', () => {
    // 'math.divide_by_zero' 와 'math.divideByZero' → 같은 키 → throw
  });
});
```

**Step 2: 실패 확인** — `bun test packages/cli/src/generate-errors.test.ts` → 모듈 미존재.

**Step 3: 구현** — `generate-errors.ts`:

- 코드→PascalCase 키 매핑 헬퍼(`math.divide_by_zero` → `MathDivideByZero` — `RustraErrorCode.TransportTimeout` 관례). 충돌 시 `throw`(코드젠 loud-fail, `codegen --check`/CI가 검출).
- 커맨드당: `const {fn}ErrorCodes: ReadonlySet<string>` + `{Fn}ErrorCode` const object(각 variant에 `description`/`retryable` JSDoc) + `{Fn}ErrorCode` 타입 + `{Fn}Error = RustraCommandError & { readonly code: {Fn}ErrorCode }` + `is{Fn}Error` 가드.
- `import { RustraCommandError } from '@rustra/types';` — 선언 커맨드가 있을 때만.
- 가드 JSDoc에 "미선언 코드(신규 네이티브 등)는 false — 폴백은 err.code 문자열 분기" 명시(설계 E-3).
- `cli-generate-files.ts`: `const errors = generateErrorsTs(schema); if (errors) addFile(outputPath, 'errors.ts', errors);` — `stageFor`에 `'errors.ts' → 'schema → ts error renderer'` 행 추가.

**Step 4: PASS 확인** — `bun test packages/cli` (기존 generate 테스트가 선언 없는 스키마에서 바이트 불변을 지키는지도 함께 — commands.ts/types.ts 스냅샷 무변경 확인)

**Step 5: 커밋** — `feat(cli): errors.ts 코드젠 — 커맨드별 에러 코드 리터럴 유니언 + 타입 가드`

---

### Task 5: 계산기 예제 채택 + 재생성 + api-surface

**Files:**

- Modify: `examples/calculator/src/lib.rs` — `divide`에 `#[command(error("math.divide_by_zero"))]` 속성 또는 register! 체인 뒤 `.command_errors("divide", …)`(매크로 폼 권장 — 1990fd5d 이후 예제가 매크로 폼); resource 4종(`resourceOpen/Read/Write/Close`)에 `"resource.not_found"` 선언(lib.rs:1108, 1136의 실제 반환 코드와 정합)
- Regenerate: `examples/calculator/generated/` — schema.json(`errors` 필드 추가), `errors.ts`(신규), `contract.ts`(계약 해시 변경 — 의도됨), `.rustra-generated.json`
- Modify: `api-surface/snapshot.json` (`bun run test:api-surface`가 갱신 지시 — 신규 public 심볼 `CommandErrorVariant`/`command_errors`/`errors_meta_if`)
- Test: `examples/calculator/ts/generated-client.test.ts` (또는 신설 `typed-errors.test.ts`) — `isDivideError` 가드로 기존 문자열 비교 대체 단언 추가

**Step 1: 실패 테스트 작성** — 계산기 ts 테스트에:

```ts
import { DivideErrorCode, isDivideError } from '../generated/errors.js';

// divide({a:10, b:0}) reject → isDivideError(e) true,
// e.code === DivideErrorCode.MathDivideByZero 타입 좁힘 단언.
// isEven 등 미선언 커맨드의 catch에는 가드가 없음(파일 존재만).
// 선언되지 않은 코드를 mock으로 던지면 isDivideError === false (forward compat).
```

**Step 2: 실패 확인** — `bun test examples/calculator/ts` → `generated/errors.js` 미존재로 실패.

**Step 3: 구현 + 재생성** — Rust 선언 → `cargo run -p rustra-calculator-example`(스키마 프로브) → `rustra codegen --config rustra.json` → 생성물 커밋. **계약 해시가 바뀌므로** `contract.ts`의 `GENERATED_CONTRACT_HASH`와 네이티브 해시가 같이 움직인다(단일 소스 — package_schema.rs:60-77). `tsc -p examples/calculator/tsconfig.json`으로 생성물 타입 체크.

**Step 4: PASS 확인** — `bun test examples/calculator/ts/*.test.ts && bun run test:ts:node && bun run test:api-surface`

**Step 5: 커밋** — `feat(example): 계산기에 타입화 에러 선언 채택 — divide/resource 코드 가드로 좁힘 + api-surface 갱신`

---

### Task 6: 문서 (en/ko 미러 대상)

**Files (전부 en/ko 쌍 갱신 — `bun run test:docs`의 docs:sync 게이트가 쌍 정합을 검사):**

- Modify: `docs/rust-api-guide.md` + `docs/rust-api-guide.ko.md` — `### RustraError` 절(rust-api-guide.md:494) 뒤에 "커맨드별 에러 코드 선언" 절 신설: `CommandErrorVariant`/`command_errors`/`#[command(error(...))]`, 코드 패턴 규칙(`^[a-z][a-z0-9_.]*$`), 도메인 vs 프레임워크 코드 구분(설계 E-1), "선언은 계약 문서이지 런타임 검증이 아니다" 명시. 기존 에러 코드 표(rust-api-guide.md:520)와 상호 참조. **오타 코드 사례 정정**: rust-api-guide.md:510의 `"division.by_zero"` → `"math.divide_by_zero"`(실제 예제 코드 examples/calculator/src/lib.rs:259 실측).
- Modify: `docs/getting-started.md` + `docs/getting-started.ko.md` — Error codes 표(getting-started.md:1040)와 TypeScript Side 에러 절(:1052-1072)에 가드 패턴 추가: `isDivideError` + `DivideErrorCode` 사용법, 문자열 비교에서 마이그레이션. **같은 오타 정정**: getting-started.md:1065의 `// "division.by_zero"` → `math.divide_by_zero`.
- Modify: `docs/wire-format.md` + `docs/wire-format.ko.md` — 변경 없음을 명시하는 1문단("에러 프레임은 `{code,message}` 그대로 — 타입화 에러는 선언/코드젠 표면만"). 와이어 문서라 무변경 원칙의 근거를 남긴다.
- Modify: `docs/plans/2026-09-07-platform-interop-stabilization-design.md` "남는 일"의 "커맨드별 타입화 에러 코드젠(격차 #2)" 항목에 착지 표기(선행 문서 갱신 — platform 트랙이 followup 슬라이스를 체크오프한 관례와 동일).

**Step 1: en 문서 갱신 → Step 2: ko 미러 갱신 → Step 3: 게이트 확인** — `bun run test:docs && bun run test:onboarding`

**Step 4: 커밋** — `docs: 타입화 에러 가이드 — rust-api-guide 선언 절 + getting-started 가드 패턴 + 와이어 무변경 명시 (en/ko)`

---

### Task 7: changeset — **사용자 승인 게이트**

**Files:**

- Create: `.changeset/typed-command-errors.md` (내용 초안은 준비하되 **생성 전 사용자 승인 필수** — 이 프로젝트는 changeset 생성이 사용자 승인 대상. 직전 트랙들도 "changeset 은 사용자 지시로 제외"였음(1990fd5d 커밋 메시지 실측))

초안(승인 후 생성):

```md
---
'@rustra/cli': minor
'rustra': minor
---

Command-scoped typed errors: declare the domain error codes a command may
return (`CommandErrorVariant` + `PackageBuilder::command_errors` /
`#[command(error(...))]`). Declarations flow into schema.json's
conditional `errors` field and `rustra codegen` emits a new `errors.ts`
(per-command error-code literal union + `is{Command}Error` type guards).
The wire error frame, host adapters, and `RustraCommandError` runtime
contract are unchanged — unknown codes keep flowing; guards simply
return false for undeclared codes.
```

**커밋** — `chore(release): 타입화 에러 changeset — CLI/코어 마이너 (사용자 승인 후)`

---

### Task 8: 전면 게이트 배터리

모든 태스크 착지 후 아래 전체를 논스톱으로 통과해야 한다(하나라도 깨지면 수정 후 처음부터 재실행):

```bash
# TS 전 패키지 (types/node/bun/tauri/react-native/testing/devtools/react/cli 빌드+테스트 포함)
bun run test:packages

# Rust 코어/매크로/네이밍
cargo test -p rustra -p rustra-naming -p rustra-macros

# Rust 정적 게이트
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

# TS 정적 게이트
bun run lint && bun run format:check

# 문서/온보딩 동기화 게이트
bun run test:docs && bun run test:onboarding

# 계약/e2e
bun run test:ts:node && bun run test:adapter:tauri
```

추가 확인(권장 — 예제 재생성 정합): `bun run test:api-surface`, `bun run --cwd packages/cli test` (codegen 유닛), `cargo test --workspace`(예제 bin 포함 전체).

**커밋** — 게이트 수정이 발생하면 각 원인 태스크에 squash하거나 `fix(gate): 전면 게이트 정합 — <원인>` 으로 별도 커밋.
