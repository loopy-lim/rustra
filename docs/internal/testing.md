# 테스트 구조 및 실행 가이드

프로젝트 기여자를 위한 내부 문서. 테스트 계층 구조, 파일별 역할, Bun 스크립트 체인, 실행 명령어를 정리한다.

---

## 테스트 계층 구조

```
cargo test (Rust 단위 테스트)
  │
  ▼
TS 테스트 (generated-client + adapter-compat + runtime-contract)
  │
  ▼
Adapter 테스트 (각 host transport 동작 검증)
  │
  ▼
Runtime 테스트 (Node / Bun / Tauri 실제 실행)
  │
  ▼
Compat 테스트 (전체 파이프라인 통합)
```

하위 계층은 상위 계층의 전제 조건이므로 위에서부터 순차적으로 통과해야 한다.

---

## Rust 테스트

### 파일: `crates/rustra/tests/public_authoring_api_tests.rs`

10개 테스트. rustra의 공개 저작 API(authoring API)를 검증한다.

| 테스트 함수                                                     | 검증 내용                                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_builds_package_without_touching_raw_engine_types`         | `Package::builder().command().build()` + `invoke()` 기본 흐름. 결과값 42 확인                                                                                                      |
| `user_can_register_command_without_writing_command_name_string` | `command_fn()`으로 자동 이름 추출. 생성된 `commands.ts`에 함수명과 command 이름 포함 확인                                                                                          |
| `register_macro_uses_macro_derived_name`                        | `register!` 매크로로 command 등록. `__RUstra_meta_*` 상수에서 이름을 자동 추출하여 올바르게 invoke되는지 확인                                                                      |
| `package_generates_host_neutral_typescript_client`              | `generate_typescript()` 결과에 `AddNumbersInput` 타입, `addNumbers` 함수, `invoke<AddNumbersOutput>` 포함 확인. `EngineRequest`, `Attachment`, `node:`, `react-native` 미포함 확인 |
| `generated_package_can_be_written_to_a_directory`               | `write_to_dir()`로 `schema.json`, `types.ts`, `commands.ts`, `contract.ts` 4개 파일 생성 확인                                                                                      |
| `unknown_command_uses_package_level_error`                      | 미등록 command 호출 시 `RustraError` 코드가 `"command.not_found"`인지 확인. `error.code()` getter 사용                                                                             |
| `ts_generator_handles_optional_fields`                          | `Option<i64>`, `Option<String>` 필드가 `age?: number \| null`, `label?: string \| null`으로 생성되는지 확인                                                                        |
| `ts_generator_handles_enums`                                    | enum 타입이 `Status` 참조 타입 + `'Active' \| 'Inactive'` union으로 생성되는지 확인                                                                                                |
| `ts_generator_handles_vec_and_optional_struct`                  | `Vec<String>` → `string[]`, `Option<Item>` → `Item \| null` 생성 확인                                                                                                              |
| `command_macro_rejects_wrong_signature`                         | `#[command]` 매크로가 잘못된 시그니처를 거부하는지 컴파일 체크로 검증. 유효 시그니처는 통과, 파라미터 없는 함수와 `Result`가 아닌 반환은 실패                                      |

### 파일: `examples/calculator/tests/example_contract.rs`

1개 통합 테스트. 계산기 예제 빌드 산출물을 종단 간 검증한다.

| 테스트 함수                                    | 검증 내용                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calculator_example_runs_and_generates_client` | `rustra-calculator-example` 바이너리 실행 → stdout에 `2 + 3 = 5` 포함 확인. `generated/commands.ts`에 `addNumbers` 함수와 `engine.invoke<AddNumbersOutput>('addNumbers')` 포함, `EngineRequest`/`Attachment` 미포함 확인 |

이 테스트는 `cargo test` 실행 시 `CARGO_BIN_EXE_rustra-calculator-example` 환경변수를 통해 빌드된 바이너리를 직접 실행하므로, 코드 생성 파이프라인 전체를 검증한다.

### 실행

```bash
cargo test
```

### Complex binary codec

`crates/rustra/src/complex_codec.rs`와 `crates/rustra/tests/rkyv_v2_wire.rs`는
schema-driven codec의 map key 정렬, Option, Set, data enum variant key와
malformed/trailing payload 경계를 검증한다. TypeScript 대응 fixture는
`packages/types/src/complex-codec.test.ts`에 있으며, 두 구현의 golden data-enum
wire가 동일해야 한다.

```bash
cargo test -p rustra --test rkyv_v2_wire oneof_command_uses_complex_binary_wire
bun test packages/types/src/complex-codec.test.ts
bun run bench:complex
```

---

## TypeScript 테스트

### 파일: `examples/calculator/ts/generated-client.test.ts`

2개 테스트. 생성된 TS 클라이언트의 동작을 검증한다.

| 테스트                                                                       | 검증 내용                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated command helper calls the host EngineClient invoke contract`       | `configure(engine)` 후 `addNumbers(input)` 호출 시 글로벌 invoke→engine에 올바른 command 이름과 args가 전달되는지 확인                             |
| `generated client stays host neutral for Node, Bun, Tauri, and React Native` | `commands.ts` + `types.ts`에 `node:`, `bun:`, `@tauri-apps`, `react-native`, `@expo/`, `expo-modules`, `EngineRequest`, `Attachment`가 없는지 확인 |

### 파일: `examples/calculator/ts/adapter-compat.test.ts`

6개 테스트. 4개 adapter 패키지의 동작과 무결성을 검증한다.

| 테스트                                                                        | 검증 내용                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `node adapter forwards generated commands to injected Node transport`         | `createNodeEngine`이 transport의 invoke를 올바르게 호출                                                  |
| `bun adapter forwards generated commands to injected Bun transport`           | `createBunEngine`이 transport의 invoke를 올바르게 호출                                                   |
| `tauri adapter forwards generated commands to injected Tauri invoke`          | `createTauriEngine`이 `rustra_dispatch`로 래핑하여 invoke 호출. `RustraCommandError` 에러 변환 동작 확인 |
| `react native adapter forwards generated commands to injected native module`  | `createReactNativeEngine`이 native module의 invoke를 올바르게 호출                                       |
| `adapter packages keep host-specific imports out of the shared contract path` | 4개 adapter 소스에 `@tauri-apps`, `react-native`, `@expo/`, `expo-modules`가 없는지 확인                 |

공통 패턴: `createRecordingTransport()`로 호출을 기록하고, `addNumbers` generated command가 올바른 파라미터로 transport에 도달하는지 확인.

### 파일: `examples/calculator/ts/runtime-contract.test.ts`

2개 테스트. host 앱들이 동일한 generated commands를 사용하는지, RN FFI 연결이 올바른지 검증한다.

| 테스트                                                                    | 검증 내용                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host apps share generated commands and differ only by adapter transport` | Node, Bun, Tauri, RN 앱이 모두 `../generated/commands.js`를 import. 각각 `createNodeEngine`, `createBunEngine`, `createTauriEngine`, `createReactNativeEngine` 사용. Tauri `main.rs`는 Rust에서 직접 `invoke` 호출하며 JS로 덧셈을 수행하지 않음 |
| `react native runtime fixture exposes a native Rust-backed invoke module` | Swift 모듈이 `RustraCalculator` 이름으로 등록, `invokeRaw` async function 노출, `rustra_calculator_invoke` / `rustra_calculator_free_string` FFI 함수 호출. Rust lib.rs에서 FFI export 확인                                                      |

### 실행

```bash
# Node.js 테스트 러너
bun run test:ts:node

# Bun 테스트 러너
bun run test:ts:bun
```

---

## Bun 스크립트 체인

`package.json`에 정의된 테스트 스크립트 체인:

```
test:ts:node        → tsc --noEmit + node --test
test:ts:bun         → bun test
test:runtime:node   → cargo build + tsc + node node-app.js
test:runtime:bun    → cargo build + bun bun-app.ts
test:adapter:tauri  → bun tauri-app.ts
test:adapter:react-native → bun react-native-app.ts
test:app:react-native → cd react-native-calculator && bun run typecheck
test:runtime:tauri  → cd tauri-calculator && bun run build && bun run smoke
test:adapters       → test:adapter:tauri + test:adapter:react-native + test:app:react-native
test:runtime        → test:runtime:node + test:runtime:bun + test:runtime:tauri
test:compat         → test:adapters + test:runtime
```

### Tauri Smoke 테스트 방식

`test:runtime:tauri`는 다음 순서로 동작한다:

1. `cargo build` — Rust 백엔드 빌드 (rustra `tauri` feature 활성화)
2. `bun run build` — Tauri 앱 빌드 (바이너리 생성)
3. `bun run smoke` — 앱 실행 → WebView에서 JS 호출(`rustra_dispatch`) → 결과 확인 → 종료

실제 Tauri 런타임에서 `createTauriEngine` → `addNumbers` → `rustra_dispatch` → Rust `invoke_json` 경로를 종단 간 검증한다.

---

## React Native 테스트 상태

| 계층                        | 상태 | 비고                                                                |
| --------------------------- | ---- | ------------------------------------------------------------------- |
| adapter-compat.test.ts      | PASS | `createReactNativeEngine` 동작 확인                                 |
| runtime-contract.test.ts    | PASS | Swift 모듈 + FFI export 구조 검증                                   |
| test:adapter:react-native   | PASS | `bun react-native-app.ts` 실행                                      |
| test:app:react-native       | PASS | TypeScript 타입체크 통과                                            |
| Android release 실기기 실행 | PASS | `TB710FU` arm64에서 complex/channel/resource/benchmark receipt 확인 |
| iOS generic device build    | PASS | `iphoneos` Debug 링크 성공; device runtime은 별도 미실행            |
| iOS Simulator 실행          | PASS | iPhone 17 Simulator Release embedded-bundle runtime receipt 확인    |

**경계:** package/build 성공은 런타임을 대체하지 않는다. Android는 실기기
runtime까지, iOS는 generic device build와 iPhone 17 Simulator runtime까지
확인했다. iOS physical-device 실행은 별도 증거다.

---

## 실행 명령어 정리

### 전체 테스트 실행

```bash
# Rust 단위 테스트
cargo test

# TS 테스트 (Node.js)
bun run test:ts:node

# TS 테스트 (Bun)
bun run test:ts:bun

# 전체 호환성 테스트
bun run test:compat
```

### 개별 계층 실행

```bash
# Adapter 테스트만
bun run test:adapters

# Runtime 테스트만
bun run test:runtime

# 특정 host 런타임
bun run test:runtime:node
bun run test:runtime:bun
bun run test:runtime:tauri

# 특정 adapter
bun run test:adapter:tauri
bun run test:adapter:react-native
bun run test:app:react-native
```

### 생성된 클라이언트 재생성

Rust 코드 변경 시 생성된 TS 클라이언트를 갱신하려면:

```bash
cargo build
# examples/calculator/generated/ 디렉토리에 자동 생성됨
```
