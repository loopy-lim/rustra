# Crate 및 Package 구조

프로젝트 기여자를 위한 내부 문서. 각 crate/package의 책임, 공개 API, 빌드 의존성 관계를 정리한다.

---

## Cargo Workspace 설정

루트 `Cargo.toml`에서 워크스페이스를 구성한다.

- **resolver**: `"3"`
- **edition**: `"2024"` (workspace.package 통해 일괄 적용)
- **license**: MIT
- **version**: 0.1.0

### Workspace Members

| Member 경로                           | 패키지명                    | 역할                                                             |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `crates/rustra`                       | `rustra`                    | 핵심 라이브러리. Package 빌더, TypeScript 코드생성, command 등록 |
| `crates/rustra-macros`                | `rustra-macros`             | `#[command]` proc macro. 컴파일 타임 시그니처 검증               |
| `examples/calculator`                 | `rustra-calculator-example` | 예제 계산기. cdylib/staticlib으로 빌드하여 RN/FFI에서 사용       |
| `examples/tauri-calculator/src-tauri` | (Tauri 앱)                  | Tauri 백엔드. rustra의 `tauri` feature 사용                      |

### Workspace Dependencies

```toml
[workspace.dependencies]
rustra-macros = { path = "crates/rustra-macros" }
rustra = { path = "crates/rustra" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = { version = "0.8", features = ["derive"] }
sha2 = "0.10"
hex = "0.4"
```

---

## 빌드 의존성 그래프

```
rustra-macros (proc-macro)
  ├─ syn 2 (full)
  ├─ quote 1
  └─ proc-macro2 1
        │
        ▼
rustra
  ├─ rustra-macros (workspace)
  ├─ schemars 0.8 (derive)
  ├─ serde 1 (derive)
  ├─ serde_json 1
  ├─ sha2 0.10
  ├─ hex 0.4
  └─ tauri 2 (optional, feature = "tauri")
        │
        ▼
rustra-calculator-example
  ├─ rustra (workspace)
  ├─ schemars (workspace)
  ├─ serde (workspace)
  └─ serde_json (workspace)
        │
        ▼
tauri-calculator (src-tauri)
  └─ rustra (workspace, features = ["tauri"])
```

---

## Crate 상세

### rustra (`crates/rustra`)

핵심 라이브러리. 사용자가 Package를 구성하고 TypeScript 클라이언트를 생성하는 진입점이다.

**공개 API:**

| 항목                                  | 종류                   | 설명                                                                                                   |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `Package`                             | struct                 | 등록된 command들을 보유하는 런타임 객체                                                                |
| `Package::builder(id)`                | method                 | `PackageBuilder` 생성                                                                                  |
| `Package::invoke()` / `invoke_json()` | method                 | command 실행 (typed / JSON)                                                                            |
| `Package::generate_typescript()`      | method                 | `GeneratedPackage` 생성                                                                                |
| `PackageBuilder`                      | struct                 | 빌더 패턴으로 command 등록                                                                             |
| `PackageBuilder::command()`           | method                 | 명시적 이름으로 command 등록                                                                           |
| `PackageBuilder::command_fn()`        | method                 | 함수명에서 자동으로 command 이름 추출                                                                  |
| `PackageBuilder::build()`             | method                 | `Package` 생성                                                                                         |
| `GeneratedPackage`                    | struct                 | 생성된 TS 클라이언트 (4개 파일)                                                                        |
| `GeneratedPackage::write_to_dir()`    | method                 | 디렉토리에 파일 쓰기                                                                                   |
| `RustraError`                         | struct                 | 에러 타입. `Serialize` 구현. `code + message` 필드 + `custom()` 생성자 + `code()` / `message()` getter |
| `command`                             | macro (re-export)      | `rustra_macros::command`                                                                               |
| `register`                            | macro (re-export)      | `rustra_macros::register`. 다중 command 일괄 등록                                                      |
| `prelude`                             | module                 | 자주 쓰는 항목 일괄 import (`command`, `register` 포함)                                                |
| `tauri_support`                       | module (feature-gated) | `RustraState`, `rustra_dispatch`, `register()` — Tauri 연동 헬퍼                                       |
| `__private`                           | module (sealed)        | `CommandInput`, `CommandOutput` trait. proc macro 전용                                                 |

**Features:**

- `tauri` — `tauri_support` 모듈 활성화. `tauri` crate을 의존성에 추가.

**주요 비공개 함수 (내부 동작):**

| 함수                               | 설명                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `schema_value::<T>()`              | `schema_for!(T)`로 JSON Schema + definitions 생성. `(Value, Value)` 튜플 반환 |
| `short_type_name::<T>()`           | `std::any::type_name`에서 마지막 세그먼트 추출                                |
| `command_name_from_handler::<F>()` | 함수 타입명 → camelCase command 이름                                          |
| `contract_hash()`                  | schema JSON → SHA256 hex                                                      |
| `ts_type_from_schema()`            | JSON Schema → TS 타입 문자열. `(schema, definitions)` 2개 인자 받음           |
| `ts_object_from_schema()`          | JSON Schema object → TS 객체 리터럴                                           |
| `command_function_name()`          | command 이름 → TS 함수명 (camelCase)                                          |
| `snake_to_lower_camel()`           | snake_case → lowerCamelCase                                                   |

---

### rustra-macros (`crates/rustra-macros`)

`#[command]` 속성 매크로와 `register!` 매크로를 제공하는 proc-macro crate.

**공개 API:**

| 항목         | 종류            | 설명                                                        |
| ------------ | --------------- | ----------------------------------------------------------- |
| `#[command]` | attribute macro | 함수 시그니처 검증 + trait bound assert + 메타 상수 생성    |
| `register!`  | macro           | 다중 command 일괄 등록. `register!(builder, fn1, fn2)` 형태 |

**`#[command]` 검증 규칙:**

1. 함수는 정확히 1개의 입력 파라미터를 가져야 함
2. 반환 타입은 `Result<O>` 형태여야 함
3. 컴파일 통과 시 `CommandInput`, `CommandOutput` trait bound를 정적 단언
4. 함수명에서 snake_case → lowerCamelCase 변환하여 command 이름 자동 생성

**`#[command]` 속성:** `#[command(name = "customName")]` 지원. 명시적으로 command 이름 지정. 생략 시 함수명 기반 자동 생성.

**`#[command]` 생성물:**

- 원본 함수 (그대로 통과)
- `const __RUstra_meta_{fn_name}: &str` — command 이름을 저장하는 상수. `register!` 매크로에서 참조
- `_assert_command_bounds::<I, O>()` — 컴파일 타임 trait bound 검증 함수

**`register!` 동작:**

```rust
rustra::register!(Package::builder("pkg"), add_numbers, multiply)
```

위 코드는 각 함수의 `__RUstra_meta_*` 상수를 읽어 `.command(name, fn)` 체인으로 확장한다.

---

## TypeScript Package 구조

`packages/` 아래 4개 adapter 패키지. 모두 순수 TypeScript이며 외부 의존성이 없다.

| 패키지 경로                          | 팩토리 함수                             | 클라이언트 타입           | 전송 계층                 |
| ------------------------------------ | --------------------------------------- | ------------------------- | ------------------------- |
| `packages/node/src/index.ts`         | `createNodeEngine(transport)`           | `NodeEngineClient`        | `NodeInvokeTransport`     |
| `packages/bun/src/index.ts`          | `createBunEngine(transport)`            | `BunEngineClient`         | `BunInvokeTransport`      |
| `packages/tauri/src/index.ts`        | `createTauriEngine({ invoke })`         | `TauriEngineClient`       | `TauriInvoke`             |
| `packages/react-native/src/index.ts` | `createReactNativeEngine(nativeModule)` | `ReactNativeEngineClient` | `ReactNativeRustraModule` |

모든 클라이언트는 `EngineClient` 인터페이스(`invoke<T>(command, args?)`)를 구현한다. Tauri adapter만 내부적으로 `rustra_dispatch`로 명령을 래핑하고, 나머지는 transport의 `invoke`를 직접 호출한다.

Tauri adapter는 추가로 `RustraError` 타입과 `RustraCommandError` 클래스를 export한다. `createTauriEngine`은 `rustra_dispatch` 에러 응답을 `RustraCommandError`로 변환하여 throw한다.

---

## Examples 구조

### calculator (`examples/calculator/`)

핵심 예제. Rust crate + TypeScript 테스트 + 생성된 클라이언트 + 여러 host 앱을 포함.

```
examples/calculator/
├── Cargo.toml          # rustra-calculator-example (rlib + staticlib)
├── src/lib.rs          # add_numbers command + calculator_package() + FFI export
├── ts/
│   ├── adapter-compat.test.ts    # 4개 adapter 동작 + host-specific import 없음
│   ├── generated-client.test.ts  # command helper 동작 + banned import 체크
│   └── runtime-contract.test.ts  # host 앱들이 같은 generated commands 사용 + RN FFI
├── generated/          # codegen 출력 (schema.json, types.ts, commands.ts, contract.ts)
├── apps/
│   ├── node-app.ts     # Node.js 런타임 앱
│   └── bun-app.ts      # Bun 런타임 앱
```

### tauri-calculator (`examples/tauri-calculator/`)

Tauri 데스크톱 앱 예제.

```
examples/tauri-calculator/
├── src/app.ts                # 프론트엔드, createTauriEngine 사용
├── src-tauri/
│   ├── Cargo.toml            # rustra (features = ["tauri"]) 의존
│   └── src/main.rs           # rustra_support::register로 Tauri에 연동
```

### react-native-calculator (`examples/react-native-calculator/`)

React Native 모바일 앱 예제.

```
examples/react-native-calculator/
├── App.tsx                           # createReactNativeEngine 사용
├── metro.config.js                   # watchFolders로 generated/ 공유
├── modules/rustra-calculator/
│   └── ios/RustraCalculatorModule.swift  # Expo Module, FFI로 Rust 호출
```
