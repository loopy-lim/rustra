# Rustra-Bridge Project Improvement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** rustra-bridge 프로젝트의 기반 인프라(CI/CD, 린트), 기능 완성도(타입 매핑, RN, 에러), DX(예제, 퍼블리싱, CLI), 기술부채(매크로, 벤치마크, 계약)를 4-phase로 개선

**Architecture:** 모노레포 구조 유지. Phase 1에서 기반을 먼저 구축하고, 이후 Phase에서 점진적으로 개선. 각 Task는 독립적으로 커밋 가능한 단위.

**Tech Stack:** TypeScript 5.9, ESLint 9 flat config, Prettier 3, Husky 9, lint-staged, GitHub Actions, Changesets, Rust edition 2024

---

## Phase 1: 기반 인프라

### Task 1: ESLint 9 flat config 설정

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (devDependencies + scripts 추가)

**Step 1: ESLint 관련 패키지 설치**

Run: `npm install -D -w rustra-bridge eslint @eslint/js typescript-eslint`

**Step 2: `eslint.config.js` 작성**

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/dist-ts/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "examples/react-native-calculator/**",
      "examples/calculator-napi/**",
    ],
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/cli/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
```

**Step 3: `package.json`에 lint 스크립트 추가**

`package.json`의 `scripts`에 다음 추가:
```json
"lint": "eslint packages/*/src/**/*.ts",
"lint:fix": "eslint packages/*/src/**/*.ts --fix"
```

**Step 4: lint 실행하여 현재 상태 확인**

Run: `npm run lint`
Expected: 경고/에러 목록 출력 (기존 코드의 문제점 파악)

**Step 5: Commit**

```bash
git add eslint.config.js package.json package-lock.json
git commit -m "chore: ESLint 9 flat config 추가"
```

---

### Task 2: Prettier 설정

**Files:**
- Create: `.prettierrc`
- Modify: `package.json` (devDependencies + scripts)

**Step 1: Prettier 설치**

Run: `npm install -D -w rustra-bridge prettier`

**Step 2: `.prettierrc` 작성**

```json
{
  "printWidth": 100,
  "singleQuote": true,
  "trailingComma": "all",
  "semi": true,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

**Step 3: `package.json`에 format 스크립트 추가**

`scripts`에 다음 추가:
```json
"format": "prettier --write 'packages/*/src/**/*.ts' 'crates/**/*.rs'",
"format:check": "prettier --check 'packages/*/src/**/*.ts' 'crates/**/*.rs'"
```

**Step 4: 전체 코드 포맷팅 실행**

Run: `npm run format`
Expected: 포맷팅된 파일 목록 출력

**Step 5: Commit**

```bash
git add .prettierrc package.json package-lock.json
git add -u
git commit -m "chore: Prettier 설정 및 전체 코드 포맷팅"
```

---

### Task 3: Husky + lint-staged 설정

**Files:**
- Create: `.husky/pre-commit`
- Modify: `package.json` (lint-staged config, scripts)

**Step 1: Husky + lint-staged 설치**

Run: `npm install -D -w rustra-bridge husky lint-staged`

**Step 2: Husky 초기화**

Run: `npx husky init`

**Step 3: `.husky/pre-commit` 파일 수정**

```sh
npx lint-staged
```

**Step 4: `package.json`에 lint-staged 설정 추가**

`package.json` 최상위에 다음 추가:
```json
"lint-staged": {
  "packages/*/src/**/*.ts": [
    "eslint --fix",
    "prettier --write"
  ],
  "*.rs": [
    "rustfmt --"
  ]
}
```

**Step 5: `package.json`의 `scripts`에 prepare 추가**

```json
"prepare": "husky"
```

**Step 6: 테스트 — 커밋 시 린트가 자동 실행되는지 확인**

임시 파일을 lint 오류나게 수정 후 커밋 시도 → lint-staged가 실행되는지 확인
확인 후 원래대로 복구

**Step 7: Commit**

```bash
git add .husky package.json package-lock.json
git commit -m "chore: Husky + lint-staged pre-commit 훅 설정"
```

---

### Task 4: GitHub Actions CI 워크플로우

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: `.github/workflows/` 디렉토리 생성**

Run: `mkdir -p .github/workflows`

**Step 2: `ci.yml` 작성**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - name: Check formatting
        run: cargo fmt --all -- --check
      - name: Clippy
        run: cargo clippy --all-targets -- -D warnings
      - name: Test
        run: cargo test --workspace

  typescript:
    runs-on: ubuntu-latest
    needs: rust
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Lint
        run: npm run lint
      - name: Format check
        run: npm run format:check
      - name: Type check
        run: npx tsc --noEmit -p examples/calculator/tsconfig.json
      - name: Test
        run: npm run test:ts:node
```

**Step 3: 워크플로우 파일 문법 검증**

Run: `cat .github/workflows/ci.yml | head -5`
Expected: YAML 파일이 정상 생성됨

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions CI 워크플로우 추가"
```

---

### Task 5: Rust 품질 도구 — rustfmt, clippy 검증

**Files:**
- Modify: `crates/rustra/Cargo.toml` (clippy 설정 확인용)

이 Task는 CI에서 `cargo fmt --check` 와 `cargo clippy`를 이미 실행하므로,
로컬에서도 실행 가능하도록 스크립트만 추가합니다.

**Step 1: `package.json`에 Rust 품질 스크립트 추가**

```json
"lint:rust": "cargo clippy --all-targets -- -D warnings",
"fmt:rust": "cargo fmt --all",
"fmt:rust:check": "cargo fmt --all -- --check"
```

**Step 2: 현재 Rust 코드 품질 확인**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: 에러 없음 (또는 수정 필요한 경고 파악)

Run: `cargo fmt --all -- --check`
Expected: 포맷팅 차이 없음

**Step 3: 필요시 코드 수정 후 Commit**

```bash
git add package.json
git commit -m "chore: Rust 품질 검사 스크립트 추가"
```

---

## Phase 2: 기능 완성도

### Task 6: Tuple 타입 매핑 추가

**Files:**
- Modify: `crates/rustra/src/codegen.rs` (tuple 매핑 로직)
- Test: 기존 Rust 테스트로 검증

**Step 1: `codegen.rs`의 `ts_type_from_schema` 함수에서 tuple 처리 추가**

현재 `array` 타입 처리 후에 tuple 감지 로직을 추가. JSON Schema에서 tuple은 `items`가 배열인 경우:

`codegen.rs`의 `ts_type_from_schema` 함수의 `"array"` 브랜치 내에 다음 로직을 추가:

```rust
"array" => {
    // Tuple: items가 배열인 경우
    if let Some(items) = schema.get("items").and_then(Value::as_array) {
        let types: Vec<String> = items
            .iter()
            .map(|s| ts_type_from_schema(s, definitions))
            .collect();
        if !types.is_empty() {
            return format!("[{}]", types.join(", "));
        }
    }
    // 일반 배열
    let item_type = schema
        .get("items")
        .map(|s| ts_type_from_schema(s, definitions))
        .unwrap_or_else(|| "unknown".to_string());
    format!("{item_type}[]")
}
```

**Step 2: 기존 테스트 통과 확인**

Run: `cargo test --workspace`
Expected: 모든 테스트 통과

**Step 3: Commit**

```bash
git add crates/rustra/src/codegen.rs
git commit -m "feat(codegen): tuple 타입 → [A, B, C] 매핑 추가"
```

---

### Task 7: Map/Record 타입 매핑 추가

**Files:**
- Modify: `crates/rustra/src/codegen.rs`

**Step 1: `additionalProperties` 기반 Record 타입 생성 로직 추가**

`ts_object_from_schema` 함수에서 `properties`가 없고 `additionalProperties`가 있는 경우 처리:

`codegen.rs`의 `ts_type_from_schema`에 `type: "object"` 브랜치에서, `properties`가 없고 `additionalProperties`가 있을 때:

```rust
"object" => {
    if schema.get("properties").is_none() {
        if let Some(additional) = schema.get("additionalProperties") {
            let value_type = ts_type_from_schema(additional, definitions);
            return format!("Record<string, {value_type}>");
        }
    }
    ts_object_from_schema(schema, definitions)
}
```

이미 `ts_object_from_schema`에서 `Record<string, unknown>` 폴백이 있으므로,
value 타입을 정확히 매핑하도록 개선.

**Step 2: 테스트**

Run: `cargo test --workspace`
Expected: 모든 테스트 통과

**Step 3: Commit**

```bash
git add crates/rustra/src/codegen.rs
git commit -m "feat(codegen): Map → Record<string, T> 타입 매핑 추가"
```

---

### Task 8: 에러 코드 도메인 세분화 + retryable 메타데이터

**Files:**
- Modify: `crates/rustra/src/error.rs` (retryable 필드, 도메인별 에러 추가)
- Modify: `packages/types/src/index.ts` (RustraError 타입 확장)

**Step 1: `error.rs`에 retryable 필드와 도메인별 에러 추가**

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RustraError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "is_false")]
    retryable: bool,
}

fn is_false(v: &bool) -> bool {
    !v
}
```

기존 팩토리 메서드들에 `retryable: false` 유지, 새 메서드 추가:

```rust
/// 네트워크/연결 오류 (재시도 가능)
pub fn transport(error: impl fmt::Display) -> Self {
    Self {
        code: "transport.error",
        message: error.to_string(),
        retryable: true,
    }
}

/// 타임아웃 에러 (재시도 가능)
pub fn timeout(error: impl fmt::Display) -> Self {
    Self {
        code: "transport.timeout",
        message: error.to_string(),
        retryable: true,
    }
}
```

**Step 2: TypeScript `RustraError` 타입 확장**

`packages/types/src/index.ts`:
```typescript
export type RustraError = {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
};
```

**Step 3: 기존 테스트 통과 확인**

Run: `cargo test --workspace && npm run build && npm run test:ts:node`
Expected: 모든 테스트 통과 (retryable은 optional이므로 기존 코드 영향 없음)

**Step 4: Commit**

```bash
git add crates/rustra/src/error.rs packages/types/src/index.ts
git commit -m "feat(error): retryable 필드 및 transport 도메인 에러 추가"
```

---

### Task 9: React Native 설정 가이드 문서화

**Files:**
- Create: `docs/react-native-setup.md`

**Step 1: RN 설정 가이드 작성**

다음 내용 포함:
- iOS 설정 (JSI 모듈, Rust static library 빌드)
- Android 설정 (Kotlin/JNI 모듈)
- `createReactNativeEngine()` 사용법
- 트러블슈팅

**Step 2: Commit**

```bash
git add docs/react-native-setup.md
git commit -m "docs: React Native 설정 가이드 추가"
```

---

## Phase 3: DX/사용성

### Task 10: Changesets 도입

**Files:**
- Create: `.changeset/config.json`
- Modify: `package.json` (devDependencies + scripts)

**Step 1: Changesets 설치**

Run: `npm install -D -w rustra-bridge @changesets/cli`

**Step 2: Changesets 초기화**

Run: `npx changeset init`

**Step 3: `.changeset/config.json` 커스터마이징**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**Step 4: `package.json`에 버전 관리 스크립트 추가**

```json
"changeset": "changeset",
"version": "changeset version",
"release": "npm run build && changeset publish"
```

**Step 5: Commit**

```bash
git add .changeset package.json package-lock.json
git commit -m "chore: Changesets 버전 관리 도구 도입"
```

---

### Task 11: CRUD 예제 추가

**Files:**
- Create: `examples/crud/src/lib.rs`
- Create: `examples/crud/ts/` (TypeScript 클라이언트)

**Step 1: Rust CRUD 예제 작성**

`examples/crud/src/lib.rs`에 다음 명령들 정의:
- `create_item` — 아이템 생성
- `get_item` — 아이템 조회
- `list_items` — 아이템 목록 (필터링)
- `update_item` — 아이템 수정
- `delete_item` — 아이템 삭제

**Step 2: TypeScript 클라이언트 테스트 작성**

**Step 3: 통합 테스트 실행**

Run: `cargo test -p rustra-crud-example && npm run test:ts:node`
Expected: 모든 테스트 통과

**Step 4: Commit**

```bash
git add examples/crud/
git commit -m "feat(examples): CRUD 패턴 예제 추가"
```

---

### Task 12: CLI watch 모드 추가

**Files:**
- Modify: `packages/cli/src/index.ts`

**Step 1: `watch` 서브커맨드 추가**

`--watch` 플래그로 schema 파일 변경을 감지하여 자동 재생성:

```typescript
if (args[0] === "generate" && args.includes("--watch")) {
  await runWatch(options);
  return;
}
```

`runWatch` 함수에서 `fs.watch`로 schema 파일 모니터링.

**Step 2: watch 모드 테스트**

수동으로 schema 파일 수정 시 자동 재생성되는지 확인.

**Step 3: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): watch 모드 추가 — schema 변경 시 자동 재생성"
```

---

## Phase 4: 아키텍처/기술부채

### Task 13: 매크로 에러 메시지 개선

**Files:**
- Modify: `crates/rustra-macros/src/lib.rs`

**Step 1: proc-macro 에러에 정확한 span 정보 추가**

`syn::Error::new_spanned` 사용하여 컴파일 에러가 정확한 코드 위치를 가리키도록 개선.

**Step 2: 기존 테스트 통과 확인**

Run: `cargo test --workspace`
Expected: 모든 테스트 통과

**Step 3: Commit**

```bash
git add crates/rustra-macros/src/lib.rs
git commit -m "refactor(macros): 컴파일 에러 span 정확도 개선"
```

---

### Task 14: 벤치마크 확장 — 큰 페이로드 + 동시성

**Files:**
- Modify: `scripts/transport-bench.mjs`

**Step 1: 다양한 페이로드 크기 벤치마크 추가**

기존 벤치마크에 1KB, 10KB, 100KB, 1MB 페이로드 테스트 추가.

**Step 2: 동시성 벤치마크 추가**

`Promise.all`로 N개의 invoke를 동시에 실행하여 처리량 측정.

**Step 3: 결과 출력 포맷 개선**

마크다운 테이블 형태로 결과 출력.

**Step 4: Commit**

```bash
git add scripts/transport-bench.mjs
git commit -m "bench: 큰 페이로드 및 동시성 벤치마크 추가"
```

---

### Task 15: 스키마 호환성 검사 엄격화

**Files:**
- Modify: `packages/types/src/index.ts` 또는 별도 검증 모듈

**Step 1: 스키마 diff 감지 로직 작성**

이전 contract hash와 현재 hash를 비교하여 breaking change 감지:
- 필드 삭제 감지
- 필드 타입 변경 감지
- required 필드 추가 감지

**Step 2: 개발 모드에서 request/response 스키마 검증**

`EngineClient`에 `__validate__` 개발 모드 옵션 추가.

**Step 3: 테스트**

**Step 4: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "feat(contract): 스키마 breaking change 감지 로직 추가"
```

---

## 실행 순서 요약

| Task | 영역 | 의존성 | 예상 시간 |
|------|------|--------|-----------|
| 1 | ESLint | 없음 | 10분 |
| 2 | Prettier | 없음 | 5분 |
| 3 | Husky/lint-staged | Task 1, 2 | 10분 |
| 4 | CI workflow | Task 1, 2 | 15분 |
| 5 | Rust 품질 스크립트 | 없음 | 5분 |
| 6 | Tuple 매핑 | 없음 | 15분 |
| 7 | Record 매핑 | 없음 | 10분 |
| 8 | 에러 핸들링 | 없음 | 20분 |
| 9 | RN 문서 | 없음 | 15분 |
| 10 | Changesets | 없음 | 10분 |
| 11 | CRUD 예제 | Task 6, 7 | 30분 |
| 12 | CLI watch | 없음 | 20분 |
| 13 | 매크로 개선 | 없음 | 20분 |
| 14 | 벤치마크 확장 | 없음 | 20분 |
| 15 | 스키마 검증 | 없음 | 25분 |

**총 예상 시간:** ~4시간
