# DX Single-Arrow Codegen Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** schema.json을 유일한 입력으로, TS CLI를 유일한 렌더러로 고정해 듀얼 패스 코드젠 혼란을 제거하고, generated 파일 자기서술 헤더 + doctor 스테일 감지 + `codegen --explain` + 온보딩 CI 게이트로 네 DX 통증을 함께 개선한다.

**Architecture:** Rust bin은 계약 프로브(schema.json 발행)로 축소하고 예제 bin의 TS 덮어쓰기를 제거한다. TS CLI가 쓰는 전 파일에 결정론적 헤더를 각인하고, doctor에 매니페스트 기반 스테일 검사 3부류를 추가한다. `codegen --explain`으로 입력→출력 지도를 출력하고, `init→doctor→codegen→demo` 임시 디렉토리 엔드투엔드 게이트를 CI에 올린다. `rustra generate --schema/--output` 직접 경로와 매니페스트 스키마 버전은 불변.

**Tech Stack:** TypeScript (NodeNext, Bun test), Rust (cargo test/clippy), Node CLI, GitHub Actions.

**Spec:** `docs/plans/2026-09-01-dx-single-arrow-codegen-design.md`

---

## Global Constraints

- public import path, generated wire bytes, 계약 해시 알고리즘은 유지한다.
- `rustra generate --schema/--output` 직접 경로(외부 프로젝트용)는 하위호환으로 유지.
- `.rustra-generated.json` 매니페스트 `schemaVersion: 1` 유지 — 형식 변경 금지.
- `contract.ts`의 `GENERATED_CONTRACT_HASH`/`SCHEMA_VERSION` 상수 형태 불변(wire 골든 게이트·OTA 의존).
- `codegen --check`는 fail-closed, 파일을 쓰지 않는다. doctor는 읽기 전용 유지(설치/수정 없음).
- 예제 `generated/` 재생성은 반드시 `rustra codegen --config <example>/rustra.json` 단일 커맨드로 (Rust 먼저 TS 나중 순서는 오케스트레이터가 보장).
- crates.io/npm 발행 금지 — changeset만 추가.
- 각 태스크는 failing test 먼저, focused test 통과, 즉시 커밋. 커밋 후 lefthook prettier 재스테이징 필요 시 amend ([[lefthook-prettier-amend]]).
- generated/ 디렉토리는 prettier 제외(`.prettierignore` `**/generated/`) — 헤더 변경이 포맷 훅과 충돌하지 않는다.

## File Map

- Modify `packages/cli/src/generate-surface.ts`, `generate-commands.ts`, `generate-contract` (해당 모듈), `codegen-postcard.ts`, `generate-positional.ts`, `generate-cpp-hpp.ts`, `generate-cpp-output.ts`, `init-entries.ts`: 헤더 각인
- Create `packages/cli/src/generated-header.ts` + `generated-header.test.ts`: 단일 헤더 렌더러
- Modify `packages/cli/src/cli-generate-files.ts`: 헤더 적용 지점
- Modify `packages/cli/src/cli-options.ts`: `--explain` 플래그
- Modify `packages/cli/src/cli-codegen.ts`: explain 분기 + 안내 메시지 정비
- Modify `packages/cli/src/cli-help.ts`: explain 문서화
- Create `packages/cli/src/codegen-explain.ts` + `codegen-explain.test.ts`: 표면 지도 모델
- Modify `packages/cli/src/doctor-checks.ts`: `codegen.generated_freshness` 검사 추가
- Modify `packages/cli/src/doctor.test.ts`: 스테일 3부류 상황 매트릭스
- Modify `crates/rustra/src/package_types.rs`: `types_ts`/`commands_ts`/`contract_ts` deprecated 문서 + `write_schema_to_dir` 신설
- Modify `examples/*/src/bin/generate.rs` (auth/streaming/crud), `examples/calculator/src/main.rs`: schema.json 전용 전환
- Modify `docs/getting-started.md` + `.ko.md`: 단일 화살 서술 정리
- Create `scripts/onboarding-gate.mjs` + `scripts/onboarding-gate.test.ts`: 온보딩 게이트
- Modify `package.json`, `.github/workflows/ci.yml`: 게이트 연결

---

### Task 1: generated 헤더 렌더러 (TDD)

**Files:**

- Create: `packages/cli/src/generated-header.ts`
- Create: `packages/cli/src/generated-header.test.ts`

**Step 1: failing 테스트 작성**

```ts
import { describe, expect, test } from 'bun:test';
import { generatedFileHeader } from './generated-header.js';

describe('generatedFileHeader', () => {
  test('deterministic — same inputs, same bytes', () => {
    const a = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    const b = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    expect(a).toBe(b);
  });

  test('contains source, regen command, do-not-edit, and stage', () => {
    const header = generatedFileHeader('rkyv-codecs.ts', 'rust-probe schema → ts renderer');
    expect(header).toContain('// ── rustra generated');
    expect(header).toContain('Source: schema.json');
    expect(header).toContain('Regen:  rustra codegen --config rustra.json');
    expect(header).toContain('DO NOT EDIT');
    expect(header).toContain('Stage:  rust-probe schema → ts renderer');
  });

  test('ends with a single newline — content follows directly', () => {
    const header = generatedFileHeader('types.ts', 'x');
    expect(header.endsWith('\n\n')).toBe(true);
    expect(header.endsWith('\n\n\n')).toBe(false);
  });
});
```

Run: `bun test packages/cli/src/generated-header.test.ts`
Expected: FAIL (모듈 부재)

**Step 2: 구현**

```ts
// packages/cli/src/generated-header.ts
/**
 * 모든 코드젠 산출물에 각인되는 자기서술 헤더.
 *
 * 듀얼 패스 시대의 유산 — "이 파일을 뭐가 만들었지? 뭘 돌려야 최신이지?" — 를
 * 파일 자체가 대답한다. 바이트 안정적이어야 한다(스냅샷·매니페스트 게이트 정합).
 */
export function generatedFileHeader(fileName: string, stage: string): string {
  return [
    `// ── rustra generated ────────────────────────────────────────`,
    `// File:   ${fileName}`,
    `// Source: schema.json (single source of truth for this file)`,
    `// Regen:  rustra codegen --config rustra.json`,
    `// Stage:  ${stage}`,
    `// DO NOT EDIT — changes will be overwritten and fail codegen --check.`,
    `// ────────────────────────────────────────────────────────────`,
    ``,
  ].join('\n');
}
```

**Step 3: 테스트 green 확인**

Run: `bun test packages/cli/src/generated-header.test.ts`
Expected: PASS (3 tests)

**Step 4: Commit**

```bash
git add packages/cli/src/generated-header.ts packages/cli/src/generated-header.test.ts
git commit -m "feat(cli): 코드젠 산출물 자기서술 헤더 렌더러"
```

### Task 2: 전 렌더러에 헤더 적용

**Files:**

- Modify: `packages/cli/src/cli-generate-files.ts` (헤더 적용 지점 — addFile 호출부에서 content 앞에 접합)
- Modify: `packages/cli/src/generate-cpp-output.ts`, `generate-cpp-hpp.ts`, `generate-positional.ts`, `init-entries.ts`: 기존 `// AUTO-GENERATED by @rustra/cli — DO NOT EDIT.` 첫 줄을 새 헤더로 교체(중복 마커 방지)
- Test: `packages/cli/src/generate.test.ts` (기존 스냅샷/바이트 테스트 활용)

**Step 1: failing 테스트**

`packages/cli/src/generate.test.ts`에 추가:

```ts
test('every generated file carries the self-describing header', async () => {
  // 기존 fixture 파이프라인으로 files 배열을 얻는 방식을 따라한다.
  // 각 file.content가 generatedFileHeader로 시작하는지 전수 단언.
  for (const file of files) {
    expect(file.content.startsWith('// ── rustra generated')).toBe(true);
  }
});
```

(정확한 fixture 구성은 기존 generate.test.ts의 헬퍼를 재사용한다 — 새 헬퍼를 만들지 않는다.)

Run: `bun test packages/cli/src/generate.test.ts`
Expected: FAIL — 헤더 미적용 파일 존재

**Step 2: cli-generate-files.ts에 적용**

`addFile` 헬퍼가 헤더를 주입하도록 한 곳에서 처리한다(각 addFile 호출부 수정 아님):

```ts
const addFile = (targetDir: string, name: string, content: string, stage: string) =>
  files.push({
    path: resolve(targetDir, name),
    content: `${generatedFileHeader(name, stage)}${content}`,
  });
```

- `types.ts`/`commands.ts`/`contract.ts`/`events.ts` → stage `'rust-probe schema → ts renderer'`
- `rkyv-codecs.ts`/`rkyv-registry.ts` → stage `'schema → ts codec renderer'`
- `node.ts`/`bun.ts`/`tauri.ts`/`react-native.ts`/RN 모듈 → stage `'schema → host entry'`
- `positional-facade.ts` → stage `'schema → positional facade'`
- C++ hpp/cpp → stage `'schema → cpp codec renderer'` (C++ 주석이므로 헤더 행 접두사 `//` 동일 — 기존 AUTO-GENERATED 행 교체)

주의:
- `init-entries.ts`의 호스트 엔트리 4종은 이미 첫 줄 마커가 있다 — 같은 헤더로 교체하고
  호출부(63-65행, 70-73행)와 이중 접합되지 않게 한다. **중복 접합 방지 검증 테스트 필수**
  (`content.includes('// ── rustra generated')` 1회만).
- 기존 골든/스냅샷 게이트(api-surface, PINNED hex wire, contract hash)는 헤더의 영향을
  받지 않는다 — wire bytes와 파일 바이트는 별개. `codegen --check` 재생성 후 전부 green이어야 한다.

**Step 3: 예제 재생성 + 전체 게이트**

```bash
bun run build
bun run --cwd packages/cli test 2>/dev/null || bun test packages/cli/src
# 예제 generated 재생성 (단일 화살 — 이 커맨드가 이후 유일한 재생성 경로다):
for ex in calculator crud auth streaming; do
  node packages/cli/dist/index.js codegen --config examples/$ex/rustra.json
done
bun run test:api-surface
```

Expected: 전부 PASS. 예제 diff에는 헤더 추가만 있어야 한다(`git diff --stat examples/`).

**Step 4: Commit**

```bash
git add packages/cli/src examples
git commit -m "feat(cli): 전 코드젠 산출물에 자기서술 헤더 각인 + 예제 재생성"
```

### Task 3: Rust bin 계약 프로브 전환

**Files:**

- Modify: `crates/rustra/src/package_types.rs` — `write_schema_to_dir` 신설 + `types_ts`/`commands_ts`/`contract_ts` 필드 deprecated 문서
- Modify: `examples/auth/src/bin/generate.rs`, `examples/streaming/src/bin/generate.rs`, `examples/crud/src/bin/generate.rs` — schema.json 전용 전환
- Modify: `examples/calculator/src/main.rs` — 데모가 `generated/`를 덮어쓰는 부작용 제거
- Test: `crates/rustra/tests/public_authoring_api_tests.rs` (신설 fn 테스트 추가)

**Step 1: failing 테스트** (`public_authoring_api_tests.rs`에 추가)

```rust
#[test]
fn write_schema_to_dir_emits_schema_only() {
    let dir = std::env::temp_dir().join(format!("rustra-probe-{}", std::process::id()));
    let package = test_package();
    package.generate_typescript().unwrap().write_schema_to_dir(&dir).unwrap();
    assert!(dir.join("schema.json").exists());
    assert!(!dir.join("types.ts").exists());
    assert!(!dir.join("commands.ts").exists());
    assert!(!dir.join("contract.ts").exists());
    std::fs::remove_dir_all(&dir).ok();
}
```

(`test_package()` 헬퍼는 파일 내 기존 패턴 따름. RUSTRA_SCHEMA_OUT 우회는 기존 `write_to_dir`과
동일하게 `write_schema_to_dir`도 존중한다 — `codegen --check`의 check-mode가 이 경로로 schema.json을
임시 디렉토리에 요구한다. **이 동작 보존이 하위호환의 핵심**.)

Run: `cargo test -p rustra --test public_authoring_api_tests`
Expected: FAIL (fn 부재)

**Step 2: 구현** (`package_types.rs`)

```rust
impl GeneratedPackage {
    /// 계약 프로브 출력 — schema.json 만 디스크에 쓴다.
    ///
    /// 단일 화살 코드젠에서 Rust bin 의 역할은 스키마 발행까지다. TS/C++ 표면은
    /// `rustra codegen` 이 schema.json 에서 렌더링한다. `RUSTRA_SCHEMA_OUT` 환경
    /// 변수를 `write_to_dir` 과 동일하게 존중한다.
    pub fn write_schema_to_dir(&self, output_dir: impl AsRef<Path>) -> crate::Result<()> {
        let requested_dir = output_dir.as_ref();
        let output_dir = std::env::var_os("RUSTRA_SCHEMA_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| requested_dir.to_path_buf());
        fs::create_dir_all(&output_dir)?;
        write_if_changed(output_dir.join("schema.json"), &self.schema_json)?;
        Ok(())
    }
}
```

`types_ts`/`commands_ts`/`contract_ts` 필드와 `write_to_dir`의 doc에 폐기 예정 표기 추가
(버전 정책: deprecated → 최소 1 minor 유지 — 이번 minor에서는 문서만, 제거는 다음 minor 판단):

```rust
/// Deprecated (단일 화살 코드젠 전환): TS 표면은 `rustra codegen`이 schema.json에서
/// 렌더링한다. 이 필드는 Node 없는 환경의 참고용으로 최소 1 minor 유지 후 제거 검토.
```

**Step 3: 예제 bin 전환**

auth/streaming/crud `src/bin/generate.rs`를 동일 형태로:

```rust
fn main() {
    let package = auth_package(); // 각 예제의 패키지 fn
    let generated = package.generate_typescript().expect("codegen failed");
    generated
        .write_schema_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))
        .expect("write failed");
}
```

calculator `main.rs`는 데모 중 `generate_typescript().write_to_dir(...)` 두 줄 제거
(데모 실행이 generated/ 를 오염시키는 부작용 제거 — 계약 해시 출력은 `contract_hash` 필드로 유지).

**Step 4: 회귀 + 게이트**

```bash
cargo clippy --all-targets -- -D warnings
cargo test -p rustra -p rustra-auth-example -p rustra-streaming-example -p rustra-crud-example 2>/dev/null || cargo test --workspace
# 예제 generated 재생성 (Task 2 커맨드 재사용) 후 git diff로 TS 파일 무변화 확인
for ex in calculator crud auth streaming; do
  node packages/cli/dist/index.js codegen --config examples/$ex/rustra.json
done
git diff --stat examples/  # → 비어 있어야 한다 (Rust bin이 TS를 더 이상 덮지 않음의 증명)
```

Expected: clippy green, 테스트 green, examples diff 비어 있음.

**Step 5: Commit**

```bash
git add crates examples
git commit -m "refactor(rust): 계약 프로브 전환 — write_schema_to_dir 신설 + 예제 bin schema.json 전용"
```

### Task 4: doctor 스테일 감지 (`codegen.generated_freshness`)

**Files:**

- Modify: `packages/cli/src/doctor-checks.ts` — 신규 검사 수집
- Test: `packages/cli/src/doctor.test.ts`

**Step 1: failing 테스트** (상황 매트릭스 — 기존 doctor.test.ts의 fake-runner/config fixture 패턴 사용)

```ts
test('doctor flags missing generated manifest', () => { /* fixture: manifest 없는 output dir → status 'warn', fix에 'rustra codegen' 포함 */ });
test('doctor flags schema drift after schema.json change', () => { /* fixture: manifest.schemaHash ≠ sha256(현재 schema) → 'warn' */ });
test('doctor flags generator version drift', () => { /* fixture: manifest.generatorVersion ≠ cliVersion → 'warn' */ });
test('doctor passes fresh generated output', () => { /* fixture: 일치 → 'pass' */ });
```

심각도는 전부 `warn`(required: false) — 스테일은 치명이 아니라 안내다. `--strict`에서만 exit 1.

Run: `bun test packages/cli/src/doctor.test.ts`
Expected: FAIL (검사 미존재)

**Step 2: 구현** (`doctor-checks.ts` `collectConfigChecks` 말미, 읽기 전용)

```ts
// 코드젠 산출물 신선도 — .rustra-generated.json 매니페스트 기반 저비용 검사.
// 바이트 전수 검증은 codegen --check 의 소관이다 (doctor 는 읽기 전용 저비용 유지).
const manifestPath = outputPath ? resolve(outputPath, '.rustra-generated.json') : undefined;
if (!manifestPath || !existsSync(manifestPath)) {
  checks.push(check('codegen.generated_freshness', 'warn', false,
    'Generated manifest is missing — generated output may be stale or absent',
    undefined, ['Run rustra codegen --config rustra.json']));
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); // parse fail → invalid 분기
  // 3부류: schemaHash 불일치 / generatorVersion 불일치 / 정상
  // schemaHash 비교는 sha256(현재 schema.json 내용) — hash.ts의 sha256 재사용
}
```

- 해시 계산은 `./hash.js`의 `sha256` 재사용 (새 해시 유틸 금지).
- 스키마 파일 자체가 없으면 기존 `codegen.schema_output` 검사가 이미 warn — 이 검사는 `skip`으로
  (이중 보고 방지).
- 검사 ID 접두사 `codegen.` — 기존 매트릭스 contract 열이 자동으로 이 검사를 공유한다
  (doctor-matrix.ts의 `id.startsWith('codegen.')` 필터). 매트릭스 구조 변경 없음.

**Step 3: 테스트 green + doctor 실측**

```bash
bun test packages/cli/src/doctor.test.ts
bun run build && node packages/cli/dist/index.js doctor --config examples/calculator/rustra.json
# → freshness pass 표시. 임의로 examples/calculator/generated/schema.json 한 글자 수정 후 재실행 → warn 표시 → revert
```

**Step 4: Commit**

```bash
git add packages/cli/src/doctor-checks.ts packages/cli/src/doctor.test.ts
git commit -m "feat(cli): doctor에 코드젠 신선도 검사 추가 — 매니페스트 3부류 스테일 감지"
```

### Task 5: `codegen --explain` (표면 지도)

**Files:**

- Create: `packages/cli/src/codegen-explain.ts` + `codegen-explain.test.ts`
- Modify: `packages/cli/src/cli-options.ts` (`explain` boolean 플래그)
- Modify: `packages/cli/src/cli-codegen.ts` (explain 분기 — cargo 실행 전 return)
- Modify: `packages/cli/src/cli-help.ts`

**Step 1: failing 테스트**

```ts
test('explain lists every surface with source and stage', () => {
  const rows = explainCodegenSurfaces({ hasCpp: true, hasReactNative: true, positional: true });
  const text = formatExplainText(rows);
  expect(rows.some((r) => r.output === 'types.ts' && r.renderer === 'ts renderer')).toBe(true);
  expect(rows.some((r) => r.output === 'rkyv-codecs.ts')).toBe(true);
  expect(text).toContain('schema.json');      // 입력은 항상 schema.json
  expect(text).toContain('rustra codegen');   // 재생성 커맨드 안내
});
test('explain honors config without cpp/rn sections', () => { /* hasCpp:false 등 축소 표 */ });
```

Run: `bun test packages/cli/src/codegen-explain.test.ts`
Expected: FAIL

**Step 2: 구현**

- `codegen-explain.ts`: `explainCodegenSurfaces(facts)` — 파순 함수(렌더러 없음, facts 주입).
  `cli-codegen.ts`의 config 해석(resolveCodegenTarget, config.cppOutput, config.reactNative 등)에서
  facts를 만들어 넣는다. 출력은 텍스트 표(기본)와 `--format json` (rows 배열).
- `cli-codegen.ts`: `options.explain`이면 표 출력 후 return (cargo/TS 실행 안 함 — 순수 조회).
- `cli-help.ts` codegen 섹션에 `--explain` 1행 추가.

**Step 3: green + 실측**

```bash
bun test packages/cli/src/codegen-explain.test.ts
bun run build && node packages/cli/dist/index.js codegen --config examples/calculator/rustra.json --explain
```

**Step 4: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): codegen --explain 표면 지도 — 입력→출력 다중 표면 추적 해소"
```

### Task 6: 온보딩 게이트 (init→doctor→codegen→demo)

**Files:**

- Create: `scripts/onboarding-gate.mjs`
- Create: `scripts/onboarding-gate.test.ts`
- Modify: `package.json` (`test:onboarding` 스크립트)
- Modify: `.github/workflows/ci.yml` (신규 step — lint/test 잡 중 하나에 추가)

**Step 1: failing 테스트** (runner 주입형 — 실제 프로세스 스폰 없이 스크립트 로직 테스트)

```ts
// onboarding-gate.test.ts — runOnboarding({ runner }) 형태로 프로세스 스폰을 주입받는다.
test('gate fails when any step exits non-zero and names the failed step', () => { /* fake runner: codegen 실패 → error에 'codegen' 포함, exit 1 */ });
test('gate runs steps in order: init, doctor, codegen, demo', () => { /* fake runner가 기록한 호출 순서 단언 */ });
```

Run: `bun test scripts/onboarding-gate.test.ts`
Expected: FAIL

**Step 2: 구현**

`onboarding-gate.mjs`:
1. 임시 디렉토리 생성(`fs.mkdtemp`)
2. `bunx --bun <repo>/packages/cli/dist/index.js init onboarding-probe` — 절대 경로 bin 사용(bunx 캐시 오염 방지)
3. `node <bin> doctor --config onboarding-probe/rustra.json`
4. `cargo build -p ...`? — 아니다. init 스캐폴드의 codegen은 예제와 달리 로컬 cargo를 요구하므로,
   게이트는 `cargo build`를 init 결과物에 대해 실행해 codegen이 실제로 돌게 한다. 순서:
   init → doctor(사전, 실패 허용 임계 없음 — 경고만 있어도 계속) → cargo build → codegen → demo(node로 index.ts 실행 — tsc 없이 `node --experimental-strip-types` 불필요하도록 init 템플릿 확인 후 결정; tsc 필요하면 tsc -p 후 node)
5. 각 step exit code 수집, 실패 시 이름과 stderr 꼬리를 포함해 exit 1 (fail-closed)
6. 임시 디렉토리 정리 (finally)

- `package.json`: `"test:onboarding": "bun test scripts/onboarding-gate.test.ts && node scripts/onboarding-gate.mjs"`
- `ci.yml`: 기존 compat 잡 뒤에 step 추가 — `run: bun run test:onboarding`.
  **schedule 트리거 스킵 가드 패턴 준수** ([[next-cycle-tracks-complete]] — workflow_run 게이트
  해당 없음, 일반 push/pull_request 잡이므로 가드 불필요하지만 잡이 schedule에서도 돌아
  거짓 그린이 되지 않게 ci.yml의 기존 잡 배치 규칙을 따른다).

**Step 3: 로컬 실측**

```bash
bun run test:onboarding
```
Expected: 임시 디렉토리에서 init→doctor→cargo build→codegen→demo 전체 green.

**Step 4: Commit**

```bash
git add scripts/onboarding-gate.mjs scripts/onboarding-gate.test.ts package.json .github/workflows/ci.yml
git commit -m "test(ci): 온보딩 게이트 — init→doctor→codegen→demo 실동행 검증"
```

### Task 7: 문서 정리 + changeset

**Files:**

- Modify: `docs/getting-started.md` + `getting-started.ko.md` — "Rust bin이 TS 생성" 류의 듀얼 패스 유도 서술을 단일 화살로 정리; `write_to_dir` 언급 교체
- Modify: `docs/development-hurdles.md` + `.ko.md` — codegen 파이프라인 도식이 새 계약(스키마 프로브 → TS 렌더)과 일치하는지 확인/수정
- Modify: `docs/internal/codegen.md` + `.ko.md` — 듀얼 패스 기술이 있으면 단일 화살로 갱신
- Create: `.changeset/dx-single-arrow-codegen.md`

**Step 1: 문서 전수 검색**

```bash
grep -rn "generate_typescript\|write_to_dir\|cargo run.*--bin generate" docs/ examples/*/README.md README.md 2>/dev/null
```
각 적중을 단일 화살 서술로 교체 (Rust bin 계약 프로브 역할 + `rustra codegen` 단일 커맨드).

**Step 2: changeset 작성**

```markdown
---
"@rustra/cli": minor
"@rustra/node": patch
"@rustra/bun": patch
"@rustra/types": patch
"@rustra/devtools": patch
"@rustra/tauri": patch
"@rustra/testing": patch
"@rustra/react": patch
"@rustra/react-native": patch
"rustra": minor
---

단일 화살 코드젠: Rust bin은 스키마 프로브만, TS CLI가 전 표면 렌더링. generated 파일 자기서술 헤더, doctor 신선도 검사, codegen --explain, 온보딩 CI 게이트.
```

(정확한 패키지/버전 범프는 changeset 파일 작성 시점 기준 — Rust `write_schema_to_dir` 신설이
minor, `write_to_dir` deprecated 문서화가 patch 수준인지 versioning-policy.md 기준으로 재확인.)

**Step 3: 최종 전체 게이트**

```bash
cargo clippy --all-targets -- -D warnings
bun run test:api-surface
bun run lint
bun run test:onboarding
bun run build && bun run test:ts:bun && bun run test:ts:node
```
Expected: 전부 green.

**Step 4: Commit**

```bash
git add docs .changeset README.md
git commit -m "docs(dx): 단일 화살 코드젠 문서 전환 + changeset"
```

---

## 마일스톤 요약

| 순서  | 산출물                                                          | 완료 판정                                  |
| ----- | --------------------------------------------------------------- | ------------------------------------------ |
| T1-2  | 헤더 렌더러 + 전 산출물 각인 + 예제 재생성                      | 전 파일 헤더 게이트 green, 예제 diff 헤더만 |
| T3    | Rust 계약 프로브 전환                                           | clippy green, examples diff 비어 있음       |
| T4    | doctor 신선도 검사                                              | 상황 매트릭스 4케이스 green, 실측 경고      |
| T5    | codegen --explain                                               | 표 스냅샷 green, 실측 출력                  |
| T6    | 온보딩 게이트                                                   | 로컬 end-to-end green, CI step 추가         |
| T7    | 문서 + changeset                                                | grep 0 잔류, 최종 게이트 전부 green         |
