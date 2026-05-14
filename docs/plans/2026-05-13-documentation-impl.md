# rustra-bridge 종합 문서화 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** rustra-bridge의 문서를 계층형 구조로 재편한다. 사용자용과 기여자용을 분리하고, 모든 새 문서를 한국어로 작성한다.

**Architecture:** docs/ 아래에 extending/, internal/, research/ 하위 디렉토리를 만들어 문서를 체계적으로 분류한다. 과거 연구 문서는 research/로 이동하여 보존하고, 루트 및 crate/package README는 현재 구현에 맞게 한국어로 재작성한다.

**Tech Stack:** Markdown, 기존 프로젝트 구조 (Rust crates, TypeScript packages)

---

## Task 1: 과거 연구 문서를 docs/research/로 이동

**Files:**

- Move: `docs/rust-local-engine-experiment-handoff.ko.md` → `docs/research/`
- Move: `docs/rust-owned-contract-package-pattern.ko.md` → `docs/research/`
- Move: `docs/tauri-like-single-invoke-architecture.ko.md` → `docs/research/`
- Move: `docs/ios-local-engine-benchmark-notes.md` → `docs/research/`
- Move: `docs/json-command-binary-payload-architecture.ko.md` → `docs/research/`
- Move: `docs/rn-rust-native-bridge-comparison.ko.md` → `docs/research/`
- Move: `docs/benchmark-plan.md` → `docs/research/`
- Move: `docs/rust-local-engine-vs-native-bridges.md` → `docs/research/`
- Modify: `docs/README.md` (이동 후 인덱스 갱신은 Task 5에서)

**Step 1: 디렉토리 생성 및 파일 이동**

```bash
mkdir -p docs/research
mv docs/rust-local-engine-experiment-handoff.ko.md docs/research/
mv docs/rust-owned-contract-package-pattern.ko.md docs/research/
mv docs/tauri-like-single-invoke-architecture.ko.md docs/research/
mv docs/ios-local-engine-benchmark-notes.md docs/research/
mv docs/json-command-binary-payload-architecture.ko.md docs/research/
mv docs/rn-rust-native-bridge-comparison.ko.md docs/research/
mv docs/benchmark-plan.md docs/research/
mv docs/rust-local-engine-vs-native-bridges.md docs/research/
```

**Step 2: 이동 확인**

```bash
ls docs/research/
```

Expected: 8개 파일 모두 존재

**Step 3: 기존 테스트 통과 확인**

```bash
cargo test --workspace
npm run test:ts:node
```

Expected: 모두 PASS (문서 이동은 코드에 영향 없음)

---

## Task 2: docs/architecture.md 작성

**Files:**

- Create: `docs/architecture.md`

**Step 1: 아키텍처 문서 작성**

다음 내용을 포함하여 작성:

1. **전체 데이터 흐름도** (ASCII art)
   - Rust command → Package → generate_typescript() → types.ts / commands.ts / contract.ts → adapter → host
   - 실제 코드 경로: `crates/rustra/src/lib.rs`의 `Package`, `PackageBuilder`, `GeneratedPackage`
2. **EngineClient 단일 인터페이스**
   - `invoke<T>(command: string, args?: unknown): Promise<T>` 하나로 모든 host 추상화
   - 출처: `examples/calculator/generated/types.ts`
3. **crate/패키지 관계**
   - `crates/rustra`: core 라이브러리 (Package, codegen, invoke)
   - `crates/rustra-macros`: `#[command]` proc macro (현재 passthrough)
   - `packages/node`, `packages/bun`, `packages/tauri`, `packages/react-native`: 각각 EngineClient 구현체
   - `examples/calculator`: 사용 예시 crate
   - `examples/tauri-calculator`: Tauri 런타임 예시
   - `examples/react-native-calculator`: RN Expo 예시
4. **계약 불변식**
   - 생성된 TypeScript 코드는 host-specific import 금지 (node:, bun:, @tauri-apps, react-native 등)
   - adapter는 서로를 import하지 않음
   - 검증: `examples/calculator/ts/generated-client.test.ts`의 banned import 체크
5. **transport 레이어 분리 원칙**
   - adapter는 transport를 주입받음 (직접 구현하지 않음)
   - 실제 transport는 app 레벨에서 결정 (subprocess, FFI, napi 등)

**Step 2: 내용 정확성 검증**

문서에서 참조하는 모든 파일 경로와 타입 이름이 실제 코드와 일치하는지 확인:

- `crates/rustra/src/lib.rs`: Package, PackageBuilder, GeneratedPackage, EngineClient
- `examples/calculator/generated/types.ts`: EngineClient 타입
- `packages/node/src/index.ts`, `packages/bun/src/index.ts` 등

---

## Task 3: docs/internal/ 작성 (3개 파일)

**Files:**

- Create: `docs/internal/crate-structure.md`
- Create: `docs/internal/codegen.md`
- Create: `docs/internal/testing.md`

**Step 1: crate-structure.md 작성**

다음 내용 포함:

1. **각 crate/package의 책임과 공개 API**

   | 크레이트/패키지         | 책임                               | 공개 API                                                                        | 의존성                                                |
   | ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
   | `crates/rustra`         | Package authoring, codegen, invoke | `Package`, `PackageBuilder`, `GeneratedPackage`, `command` macro, `RustraError` | rustra-macros, serde, serde_json, schemars, sha2, hex |
   | `crates/rustra-macros`  | `#[command]` proc macro            | `command` attribute macro                                                       | proc_macro                                            |
   | `packages/node`         | Node → EngineClient                | `createNodeEngine(transport)`                                                   | 없음 (순수 TS)                                        |
   | `packages/bun`          | Bun → EngineClient                 | `createBunEngine(transport)`                                                    | 없음                                                  |
   | `packages/tauri`        | Tauri → EngineClient               | `createTauriEngine({ invoke })`                                                 | 없음                                                  |
   | `packages/react-native` | RN → EngineClient                  | `createReactNativeEngine(nativeModule)`                                         | 없음                                                  |

2. **빌드 의존성 그래프** (ASCII)
   - Cargo workspace: rustra ← rustra-macros, rustra-calculator-example ← rustra
   - npm: 각 adapter package는 독립적

3. **examples/ 구조**
   - calculator: 순수 Rust crate + 생성된 TS + 테스트
   - tauri-calculator: Tauri 앱 (src-tauri/ Rust 백엔드)
   - react-native-calculator: Expo 앱 (Swift 네이티브 모듈 포함)

**Step 2: codegen.md 작성**

다음 내용 포함:

1. **schema → TS 타입 매핑 규칙** (`ts_type_from_schema` 함수 기준)
   - `object` → `{ field: type; ... }`
   - `integer` / `number` → `number`
   - `string` → `string`
   - `boolean` → `boolean`
   - `array` → `type[]`
   - 기타 → `unknown`
2. **command 이름 변환**
   - `command_fn`: `type_name::<F>()`에서 함수명 추출 → `snake_to_lower_camel` → camelCase command name
   - `command`: 명시적 이름 문자열 사용
   - `command_function_name`: command name → TS 함수명 (구분자 후 첫 글자 대문자)
3. **contract hash**
   - schema.json 전체를 SHA256 해시
   - `contract.ts`에 `GENERATED_CONTRACT_HASH` 상수로 저장
4. **현재 미지원 타입**
   - enum, union, nested $ref, null, optional 필드의 | null 미표현
   - `schemars`의 고급 기능 (flatten, oneOf 등) → 모두 `unknown` 폴백

**Step 3: testing.md 작성**

다음 내용 포함:

1. **테스트 계층 구조**
   ```
   cargo test --workspace          Rust 단위 테스트
   npm run test:ts:node            Node TypeScript 테스트 (adapter-compat + generated-client + runtime-contract)
   npm run test:ts:bun             Bun TypeScript 테스트 (동일 파일)
   npm run test:adapters           adapter injection 테스트 (Tauri, RN mock)
   npm run test:runtime            실제 Rust 프로세스 호출 (Node, Bun, Tauri)
   npm run test:compat             전체 (TS + adapters + runtime)
   ```
2. **테스트 파일별 역할**
   - `crates/rustra/tests/public_authoring_api_tests.rs`: Package 빌드, invoke, codegen, 에러 코드
   - `examples/calculator/ts/adapter-compat.test.ts`: 4개 adapter가 동일 패턴으로 동작하는지
   - `examples/calculator/ts/generated-client.test.ts`: 생성된 코드에 host-specific import 없는지
   - `examples/calculator/ts/runtime-contract.test.ts`: 모든 host 앱이 같은 generated commands 사용하는지
3. **Tauri smoke 테스트** (`examples/tauri-calculator/`)
   - 실제 앱 빌드 → 실행 → WebView JS가 Rust command 호출 → 종료
4. **React Native 상태**
   - adapter 테스트: PASS (mock injection)
   - runtime 테스트: 대기중 (시뮬레이터/디바이스 실행 필요)
   - Expo 앱 typecheck: PASS

---

## Task 4: docs/getting-started.md 작성

**Files:**

- Create: `docs/getting-started.md`

**Step 1: 사용자 가이드 작성**

다음 내용 포함:

1. **설치**
   ```toml
   [dependencies]
   rustra = "0.1"
   serde = { version = "1", features = ["derive"] }
   schemars = { version = "0.8", features = ["derive"] }
   ```
2. **최소 예제** (calculator 재구성, 실제 코드 기반)
   - Rust 타입 정의: `AddNumbersInput`, `AddNumbersOutput` with derives
   - `#[command]` 함수: `add_numbers`
   - Package builder: `Package::builder("example.calculator").command_fn(add_numbers).build()`
   - TypeScript 생성: `package.generate_typescript()?.write_to_dir("generated")?`
3. **생성된 TypeScript 결과물 설명**
   - `types.ts`: `EngineClient` 타입 + 입력/출력 타입
   - `commands.ts`: typed command helper (addNumbers)
   - `contract.ts`: contract hash 상수
   - `schema.json`: 전체 JSON Schema
4. **adapter 선택 가이드**

   ```ts
   // Node (subprocess)
   import { createNodeEngine } from '@rustra/node';
   const engine = createNodeEngine({ invoke: myTransport });

   // Bun (subprocess 또는 FFI)
   import { createBunEngine } from '@rustra/bun';
   const engine = createBunEngine({ invoke: myTransport });

   // Tauri
   import { createTauriEngine } from '@rustra/tauri';
   const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });

   // React Native
   import { createReactNativeEngine } from '@rustra/react-native';
   const engine = createReactNativeEngine(NativeModule);
   ```

5. **실행 및 테스트**
   ```bash
   cargo run -p rustra-calculator-example
   npm run test:compat
   ```

---

## Task 5: docs/extending/ 작성 (2개 파일)

**Files:**

- Create: `docs/extending/transport-guide.md`
- Create: `docs/extending/adding-host.md`

**Step 1: transport-guide.md 작성**

다음 내용 포함:

1. **transport란**
   - adapter 내부에서 Rust를 호출하는 구체적인 수단
   - adapter 패키지는 transport를 주입받아 EngineClient로 래핑할 뿐, transport 자체는 구현하지 않음
2. **현재 구현 현황표**

   | Host         | 현재 transport                 | Rust 진입점                           | 대안               |
   | ------------ | ------------------------------ | ------------------------------------- | ------------------ |
   | Node         | subprocess stdio (`spawnSync`) | `main.rs`의 `run_invoke_stdio`        | napi-rs, WASM      |
   | Bun          | subprocess stdio (`spawnSync`) | `main.rs`의 `run_invoke_stdio`        | `bun:ffi` (C FFI)  |
   | Tauri        | `window.__TAURI__.core.invoke` | Tauri command handler                 | -                  |
   | React Native | C FFI (`extern "C"`)           | `lib.rs`의 `rustra_calculator_invoke` | TurboModule, Nitro |

3. **교체 절차** (일반화)
   - Step 1: Rust 쪽에 새 진입점 추가 (필요시)
   - Step 2: adapter 패키지에서 transport 구현
   - Step 3: 기존 테스트로 회귀 검증
4. **예시: Bun FFI 교체**
   - Rust: `rustra_calculator_invoke` C FFI 이미 존재 (`examples/calculator/src/lib.rs`)
   - Bun: `bun:ffi`로 `.dylib`/`.so` 로드 후 `invoke` 매핑
   - 실제 코드 예시 포함
5. **예시: Node napi-rs 교체**
   - Rust: `#[napi]` proc macro로 바인딩 추가
   - Node: `.node` 네이티브 모듈 로드
   - 실제 코드 예시 포함

**Step 2: adding-host.md 작성**

다음 내용 포함:

1. **최소 요구사항**: `invoke<T>(command: string, args?: unknown): Promise<T>` 구현
2. **새 adapter 만들기** (packages/ 아래)
   - `packages/<host>/src/index.ts` 파일 구조
   - `packages/<host>/README.md`
3. **Rust 진입점 선택 기준**
   - C FFI: React Native, Bun, 임베디드 — 언어 바인딩이 자유로움
   - stdio: Node, Bun — 범용, 프로세스 경계
   - napi-rs: Node — 고성능, 복잡한 빌드
   - Tauri invoke: Tauri — 프레임워크 내장
4. **테스트 추가**
   - `examples/calculator/ts/adapter-compat.test.ts`에 새 adapter 테스트 추가
   - `examples/calculator/apps/<host>-app.ts` 런타임 앱 추가
   - `package.json`에 npm script 추가

---

## Task 6: 루트 README.md 재작성

**Files:**

- Modify: `README.md`

**Step 1: README 재작성**

다음 구조로 한국어 재작성:

1. **프로젝트 소개** (1-2문장)
   - rustra: Rust 패키지를 한 번 정의하면 host-neutral TypeScript 클라이언트를 생성하는 도구
2. **구조**
   ```
   crates/
     rustra/          Rust 패키지 authoring API
     rustra-macros/   #[command] 매크로
   packages/
     node/            Node adapter
     bun/             Bun adapter
     tauri/           Tauri adapter
     react-native/    React Native adapter
   examples/
     calculator/      기본 예시
     tauri-calculator/ Tauri 런타임 예시
     react-native-calculator/ Expo 예시
   ```
3. **기본 사용법** (코드 예시 — 기존 README와 동일하지만 한국어 설명)
4. **생성된 TypeScript**
   - EngineClient 인터페이스
   - command helper
5. **검증 명령**
   ```bash
   cargo test --workspace
   cargo run -p rustra-calculator-example
   npm run test:compat
   ```
6. **문서 링크** → `docs/` 안내

---

## Task 7: crate/package/example README 갱신

**Files:**

- Modify: `crates/rustra/README.md`
- Modify: `packages/node/README.md`
- Modify: `packages/bun/README.md`
- Modify: `packages/tauri/README.md`
- Modify: `packages/react-native/README.md`
- Modify: `examples/calculator/README.md`

**Step 1: crates/rustra/README.md 한국어 재작성**

기존 영어 내용을 한국어로 번역하면서, 현재 구현에 맞게 정확도 향상:

- Cargo.toml 의존성 설정
- 타입 정의 + `#[command]` + Package builder 예시
- generate_typescript() 결과물
- 주의: `command_fn`은 `type_name` 기반 이름 추출 사용 (불안정 가능성)

**Step 2: packages/\*/README.md 갱신 (4개)**

각 README에 다음 내용 포함:

- 이 adapter의 역할 (1문장)
- 공개 API (createXxxEngine)
- 사용 예시
- 주의: 이 패키지는 transport를 선택하지 않음 (호출자가 주입)

**Step 3: examples/calculator/README.md 한국어 재작성**

---

## Task 8: docs/README.md 작성 (문서 인덱스)

**Files:**

- Modify: `docs/README.md`

**Step 1: 문서 인덱스 작성**

```markdown
# rustra 문서

rustra는 Rust 패키지를 한 번 정의하면, host-neutral TypeScript 클라이언트를 자동 생성하는 도구입니다.

## 읽기 경로

### 라이브러리 사용자

1. [아키텍처 개요](architecture.md) — 전체 구조 파악
2. [시작하기](getting-started.md) — 설치 및 기본 사용법
3. [Transport 교체 가이드](extending/transport-guide.md) — Bun FFI, Node napi-rs 등
4. [새 Host 추가 가이드](extending/adding-host.md) — Electron, Deno 등

### 프로젝트 기여자

1. [아키텍처 개요](architecture.md) — 전체 구조 파악
2. [Crate 구조](internal/crate-structure.md) — 각 crate/package의 책임
3. [Codegen](internal/codegen.md) — TypeScript 생성 로직
4. [테스트 전략](internal/testing.md) — 테스트 계층 구조

## 전체 문서 목록

...
```

---

## Task 9: 최종 검증

**Step 1: 모든 테스트 통과 확인**

```bash
cargo test --workspace
npm run test:compat
```

Expected: 모두 PASS

**Step 2: 문서 내 링크 검증**

모든 문서에서 참조하는 파일 경로가 존재하는지 확인.

**Step 3: 과거 문서 보존 확인**

```bash
ls docs/research/
```

Expected: 8개 파일 존재
