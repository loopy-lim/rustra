# rustra-bridge 아키텍처

## 개요

rustra는 Rust 패키지를 한 번 정의하면 host-neutral TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다. Rust 측에서 command 함수를 작성하고 `Package`로 등록하면, `generate_typescript()`가 TypeScript 타입 정의와 command helper 함수를 생성한다. 생성된 TypeScript 코드는 어떤 런타임(Node.js, Bun, Tauri, React Native)에도 종속되지 않으며, 각 host adapter가 transport를 주입받아 `EngineClient` 인터페이스로 래핑하는 방식으로 동작한다.

---

## 전체 데이터 흐름도

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                         Rust (작성 시점)                            │
 │                                                                     │
 │  #[command]                                                         │
 │  fn add_numbers(a: i64, b: i64) -> i64                             │
 │                                                                     │
 │         │                                                           │
 │         ▼                                                           │
 │  Package::builder("examples.calculator")                            │
 │      .register(add_numbers)                                         │
 │      .build()                                          Package      │
 │                                                             │       │
 │         ┌───────────────────────────────────────────────────┘       │
 │         ▼                                                           │
 │  package.generate_typescript()                                      │
 │         │                                                           │
 │         ▼                                                           │
 │  GeneratedPackage {                                                 │
 │      schema_json,      → schema.json                                │
 │      types_ts,         → types.ts    (EngineClient + I/O 타입)      │
 │      commands_ts,      → commands.ts (command helper 함수)          │
 │      contract_hash,    → contract.ts (계약 해시)                    │
 │  }                                                                  │
 │                                                                     │
 │  generated.write_to_dir("./generated")                              │
 └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    TypeScript (런타임)                               │
 │                                                                     │
 │  generated/types.ts        generated/commands.ts                    │
 │  ┌──────────────────┐      ┌──────────────────────────────────┐     │
 │  │ EngineClient     │◄─────│ addNumbers(engine, { a, b })     │     │
 │  │ AddNumbersInput  │      └──────────┬───────────────────────┘     │
 │  └──────────────────┘                 │                             │
 │          ▲                            │ engine.invoke()             │
 │          │                            │                             │
 │  ┌───────┴────────────────────────────┴───────────────────────┐     │
 │  │                    host adapter                             │     │
 │  │  createNodeEngine(transport)                                │     │
 │  │  createBunEngine(transport)                                 │     │
 │  │  createTauriEngine({ invoke })                              │     │
 │  │  createReactNativeEngine(nativeModule)                      │     │
 │  └──────────────────────────────┬─────────────────────────────┘     │
 │                                 │                                   │
 │                                 ▼                                   │
 │  ┌──────────────────────────────────────────────────────────────┐   │
 │  │  transport (앱 레벨에서 결정)                                 │   │
 │  │  subprocess stdio / C FFI / napi / Tauri IPC / Expo native   │   │
 │  └──────────────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## EngineClient: 시스템의 핵심 계약

`EngineClient`는 생성된 TypeScript 코드와 host adapter 사이의 유일한 계약이다. 모든 command helper 함수는 이 인터페이스만 의존하며, host-specific 코드를 포함하지 않는다.

```ts
// types.ts 에 자동 생성됨
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

각 host adapter는 transport를 주입받아 이 인터페이스를 구현한 객체를 반환한다:

| adapter 패키지          | 팩토리 함수                             | 반환 타입                 | 파일 경로                            |
| ----------------------- | --------------------------------------- | ------------------------- | ------------------------------------ |
| `packages/node`         | `createNodeEngine(transport)`           | `NodeEngineClient`        | `packages/node/src/index.ts`         |
| `packages/bun`          | `createBunEngine(transport)`            | `BunEngineClient`         | `packages/bun/src/index.ts`          |
| `packages/tauri`        | `createTauriEngine({ invoke })`         | `TauriEngineClient`       | `packages/tauri/src/index.ts`        |
| `packages/react-native` | `createReactNativeEngine(nativeModule)` | `ReactNativeEngineClient` | `packages/react-native/src/index.ts` |

모든 반환 타입(`NodeEngineClient`, `BunEngineClient`, `TauriEngineClient`, `ReactNativeEngineClient`)은 구조적으로 `EngineClient`와 동일한 `invoke<T>` 메서드를 제공한다.

### command helper 사용 예시

`commands.ts`에 생성된 각 command helper는 `EngineClient`를 첫 번째 인자로 받는다:

```ts
// examples/calculator/generated/commands.ts (자동 생성됨)
import type { AddNumbersInput, EngineClient } from './types.js';

export function addNumbers(
  engine: EngineClient,
  input: AddNumbersInput,
): Promise<number> {
  return engine.invoke<number>('addNumbers', input);
}
```

사용 예시 (Tauri):

```ts
// examples/tauri-calculator/src/app.ts
import { addNumbers } from '../../calculator/generated/commands.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';

const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
const result = await addNumbers(engine, { a: 20, b: 22 });
```

---

## crate 및 패키지 관계

### Rust crates

```
crates/
├── rustra/              # core crate
│   └── src/lib.rs       # Package, PackageBuilder, GeneratedPackage, codegen, invoke, tauri_support
│
└── rustra-macros/       # proc-macro crate
    └── src/lib.rs       # #[command] attribute macro
```

#### `crates/rustra` (core)

핵심 타입과 로직을 제공한다.

| 구성 요소          | 설명                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Package`          | 등록된 command들의 컬렉션. `invoke_json()`으로 런타임 디스패치, `generate_typescript()`로 코드 생성                                                 |
| `PackageBuilder`   | `Package::builder(id)`로 생성. `.command_fn(handler)` / `.command(name, handler)`로 command 등록 후 `.build()`                                      |
| `GeneratedPackage` | `generate_typescript()`의 결과. `schema_json`, `types_ts`, `commands_ts`, `contract_hash` 필드 보유. `write_to_dir()`로 파일 출력                   |
| `RustraError`      | `Serialize` 구현. `command.not_found`, `command.invalid_args`, `internal` 에러 코드 + `custom(code, message)` 생성자 + `code()`, `message()` getter |
| `build!`           | `rustra-macros`에서 제공. `rustra::build!("id", fn1, fn2).done()` 형태로 다중 command 일괄 등록                                                    |
| `tauri_support`    | `cfg(feature = "tauri")` 활성화 시 제공. `RustraState`, `rustra_dispatch` 단일 Tauri command, `register()` 빌더 주입 함수                           |
| `__private` 모듈   | `CommandInput`, `CommandOutput` sealed 트레이트. proc macro가 컴파일 타임에 command 타입 제약을 검증하는 데 사용. public API로 노출되지 않음        |

#### `crates/rustra-macros` (proc-macro)

`#[command]` attribute macro를 제공한다. 적용된 함수에 대해:

1. 함수가 최소 1개의 파라미터를 가지는지 검증
2. 스칼라 파라미터(2개 이상) 또는 구조체 파라미터(1개) 모드를 자동 감지
3. `rustra::__private::CommandInput` / `CommandOutput` 트레이트 바운드를 만족하는지 컴파일 타임에 정적 검증
4. `#[command(name = "customName")]` 속성으로 명시적 command 이름 지정 가능. 생략 시 함수명을 snake_to_lower_camel 변환하여 자동 생성

함수 본문은 그대로 통과시키며 (identity passthrough), 컴파일 타임 타입 체크만 수행한다. 또한 `const __RUstra_meta_{fn_name}: &str = "commandName"` 상수를 생성하여 `build!` 매크로에서 command 이름을 참조할 수 있게 한다.

`build!` 매크로는 `#[command]`가 생성한 메타 상수를 이용하여 여러 command를 한 번에 등록한다:

```rust
rustra::build!("my.pkg", add_numbers, multiply)
    .done()
```

### TypeScript packages

```
packages/
├── node/           → createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient
├── bun/            → createBunEngine(transport: BunInvokeTransport): BunEngineClient
├── tauri/          → createTauriEngine({ invoke: TauriInvoke }): TauriEngineClient
└── react-native/   → createReactNativeEngine(nativeModule: ReactNativeRustraModule): ReactNativeEngineClient
```

각 adapter 패키지는 서로를 import하지 않으며, host-specific 패키지를 직접 import하지도 않는다. 호출자가 transport 객체를 생성하여 주입하는 방식이다.

### 예시 프로젝트

```
examples/
├── calculator/                 # 기본 Rust 라이브러리 예시
│   ├── src/lib.rs              # command 정의 + calculator_package() + C FFI 진입점
│   ├── src/main.rs             # stdio 진입점 + 코드 생성 데모
│   └── generated/              # generate_typescript() 출력 결과
│       ├── types.ts            # EngineClient + AddNumbersInput/Output 타입
│       ├── commands.ts         # addNumbers() helper
│       ├── contract.ts         # GENERATED_CONTRACT_HASH 상수
│       └── schema.json         # JSON Schema 표현
│
├── tauri-calculator/           # Tauri 런타임 예시
│   ├── src/app.ts              # createTauriEngine → addNumbers 사용
│   └── src-tauri/src/main.rs   # tauri_support::register()로 Package 등록
│
└── react-native-calculator/    # Expo React Native 예시
    ├── App.tsx                 # createReactNativeEngine → addNumbers 사용
    └── modules/rustra-calculator  # 네이티브 모듈 (Expo module)
```

---

## 코드 생성 파이프라인

### Rust 측: command 등록

```rust
// examples/calculator/src/lib.rs
#[command]
pub fn add_numbers(a: i64, b: i64) -> i64 {
    a + b
}

pub fn calculator_package() -> Package {
    rustra::build!("examples.calculator", add_numbers).done()
}
```

`command_fn()`은 제네릭 파라미터에서 함수의 타입 이름을 추출한다 (`command_name_from_handler::<F>()`).Closure 타입 이름의 마지막 세그먼트에서 `_command` 접미사를 제거한 뒤 snake_case를 lowerCamelCase로 변환한다.

`command()`은 이름을 직접 지정할 수 있다:

```rust
.command("myCommand", my_handler)
```

### TypeScript 생성 과정

`package.generate_typescript()` 호출 시:

1. **`schema_json`**: 모든 command의 메타데이터를 JSON Schema 형태로 직렬화. 각 command마다 `name`, `inputType`, `outputType`, `inputSchema`, `outputSchema`를 포함.
2. **`contract_hash`**: `schema_json`의 SHA-256 해시. Rust/TS 양쪽에서 동일한 계약을 사용 중인지 확인하는 용도.
3. **`types_ts`**: `EngineClient` 타입 정의 + 각 command의 I/O 타입을 `schemars` JSON Schema에서 TypeScript 타입으로 변환.
4. **`commands_ts`**: 각 command마다 `engine.invoke<OutputType>('commandName', input)`을 호출하는 helper 함수.

타입 변환 규칙 (`ts_type_from_schema`):

| JSON Schema type     | TypeScript                |
| -------------------- | ------------------------- |
| `object`             | `{ property: type; ... }` |
| `integer` / `number` | `number`                  |
| `string`             | `string`                  |
| `boolean`            | `boolean`                 |
| `array`              | `itemType[]`              |
| 기타                 | `unknown`                 |

`$defs` (공유 정의)는 모든 command의 정의를 병합한 뒤 인라인으로 전개한다. 현재는 별도의 named 타입 추출 없이 전체 스키마 트리를 직접 변환한다.

### 생성 결과물의 파일 구조

`GeneratedPackage::write_to_dir(output_dir)`이 출력하는 파일:

| 파일          | 내용                           | 용도                        |
| ------------- | ------------------------------ | --------------------------- |
| `schema.json` | 전체 계약의 JSON Schema 표현   | 디버깅, 도구 연동           |
| `types.ts`    | `EngineClient` + I/O 타입 정의 | command helper의 의존 대상  |
| `commands.ts` | command helper 함수들          | 앱 코드에서 import하여 사용 |
| `contract.ts` | `GENERATED_CONTRACT_HASH` 상수 | 런타임 계약 무결성 검증     |

---

## 런타임 디스패치

Rust `Package`는 두 가지 invoke 인터페이스를 제공한다:

```rust
// 타입 안전한 인터페이스
pub fn invoke<I, O>(&self, name: &str, input: I) -> Result<O>

// JSON 기반 인터페이스 (FFI, IPC에서 사용)
pub fn invoke_json(&self, name: &str, params: Value) -> Result<Value>
```

`invoke_json()`은 내부적으로 `BTreeMap<String, Command>`에서 command를 이름으로 조회한 뒤, 등록 시 생성한 클로저를 실행한다. 각 `Command`는 입력 JSON을 `serde_json::from_value`로 역직렬화하고, 핸들러를 호출한 뒤, 결과를 `serde_json::to_value`로 직렬화한다.

---

## transport 레이어 분리 원칙

```
┌──────────────────────────────────────────────────────────┐
 │  앱 코드                                                 │
 │  addNumbers(engine, { a: 1, b: 2 })                     │
 │          │                                               │
 │          ▼                                               │
 │  engine.invoke<AddNumbersOutput>('addNumbers', input)   │
 │          │                                               │
 │          ▼                                               │
 │  host adapter (createXxxEngine)                          │
 │  - Node:      transport.invoke(command, args)            │
 │  - Bun:       transport.invoke(command, args)            │
 │  - Tauri:     invoke('rustra_dispatch', {command, args}) │
 │  - RN:        nativeModule.invoke(command, args)         │
 │          │                                               │
 │          ▼                                               │
 │  transport (앱 레벨에서 생성/주입)                        │
 │  - subprocess stdio  (examples/calculator/src/main.rs)   │
 │  - C FFI            (examples/calculator/src/lib.rs)     │
 │  - Tauri IPC        (rustra_support::rustra_dispatch)    │
 │  - Expo native      (react-native-calculator/modules/)   │
└──────────────────────────────────────────────────────────┘
```

핵심 원칙:

1. **adapter는 transport를 주입받는다**: adapter 패키지는 transport 객체를 인자로 받아 `EngineClient`로 래핑할 뿐, transport 자체를 생성하지 않는다.
2. **transport는 앱 레벨에서 결정된다**: subprocess, FFI, napi 등 실제 통신 수단은 adapter가 아닌 앱 코드에서 선택하고 구성한다.
3. **transport 교체가 adapter 교체 없이 가능하다**: 동일한 adapter로 다른 transport를 주입할 수 있으며, 반대도 마찬가지다.

### Tauri의 특수 처리

Tauri adapter는 다른 adapter와 달리 command를 직접 전달하지 않고 `rustra_dispatch`라는 단일 진입점으로 래핑한다:

```ts
// packages/tauri/src/index.ts
return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
```

이는 Tauri의 IPC가 미리 등록된 command만 호출할 수 있기 때문이다. Rust 측 `tauri_support` 모듈이 `rustra_dispatch` Tauri command를 단일 진입점으로 등록하고, 내부적으로 `Package::invoke_json()`으로 라우팅한다:

```rust
// crates/rustra/src/lib.rs (tauri_support 모듈)
pub struct RustraState {
    pub package: Package,
}

#[tauri::command]
pub fn rustra_dispatch(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    state.package.invoke_json(&command, args).map_err(|e| {
        serde_json::to_value(&e)
            .unwrap_or_else(|_| json!({"code": "unknown", "message": "unknown error"}))
    })
}

pub fn register<R: tauri::Runtime>(
    package: Package,
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder
        .manage(RustraState { package })
        .invoke_handler(tauri::generate_handler![rustra_dispatch])
}
```

사용 예시:

```rust
// examples/tauri-calculator/src-tauri/src/main.rs
let package = calculator_package();
let builder = rustra::tauri_support::register(package, tauri::Builder::default());
```

---

## 런타임 명령 레지스트리 (dev / prod)

`Package` 내부는 가변 레지스트리로, `Arc<RwLock<RegistryState>>` + `Arc<AtomicBool> frozen` 이다.

```rust
pub struct Package {
    id: String,
    state: Arc<RwLock<RegistryState>>,
    frozen: Arc<AtomicBool>,
}

struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16, // 단조 증가, retired id 재사용 금지
}
```

### dev / prod 분리

`build()` 시 `frozen = !cfg!(debug_assertions)`:

| 빌드 | `frozen` 기본값 | 런타임 mutation |
|------|----------------|-----------------|
| debug (`debug_assertions`) | `false` | `register`/`register_fn`/`replace`/`unregister` 허용 |
| release | `true` | 모두 `Err("registry.frozen")` |

`Package::freeze()` 로 언제든 명시적 봉인 가능(debug에서 prod 동작 시뮬레이션 등). 한 번 동결하면 해제 불가.

### mutation API

| 메서드 | 동작 | 실패 |
|--------|------|------|
| `register(name, handler)` | 등록. 같은 이름이면 핸들러 덮어쓰기(기존 `command_id` 유지) | `registry.frozen` / `registry.id_exhausted` |
| `register_fn(handler)` | 이름 자동 추론 등록 | 위와 동일 |
| `replace(name, handler)` | 핸들러 교체(`command_id` 유지) | `command.not_found` / `registry.frozen` |
| `unregister(name)` | 제거(`command_id` retired) | `command.not_found` / `registry.frozen` |

### 동시성

- 읽기(`invoke_json`, `invoke_rkyv_v2`, `generate_typescript`) = 읽기 잠금, mutation = 쓰기 잠금.
- 핸들러 실행 중에는 잠금을 hold 하지 않는다(`Command`를 clone-out 후 락 해제). 핸들러가 다시 `register`/`unregister`를 호출하는 **재진입 교착**을 방지한다.
- prod 읽기 fast-path(무경쟁 `RwLock` read ≈ 10ns)는 벤치마크(3.8µs) 대비 무시 가능한 수준이다.

### 동적 명령의 호출 경로

- **정적 등록 명령**(codegen으로 `schema.json`에 `command_id` 노출) → rkyv V2 바이너리 fast-path 유지.
- **런타임 등록 명령**(schema에 ID 없음) → 이름/JSON 경로(`engine.invoke('name', ...)`)로만 호출. 바이너리 fast-path는 미지원(자연스러운 스코핑).

---

## 계약 불변식

rustra-bridge는 다음 불변식을 통해 host-neutral 특성을 보장한다:

1. **생성된 TypeScript는 host-specific import를 금지한다**: `types.ts`, `commands.ts`, `contract.ts`는 `node:`, `bun:`, `@tauri-apps`, `react-native`, `expo-modules` 등 어떤 host-specific 모듈도 import하지 않는다. 유일한 import는 `commands.ts`가 `types.js`를 참조하는 것뿐이다.

2. **adapter 패키지는 서로를 import하지 않는다**: `packages/node`, `packages/bun`, `packages/tauri`, `packages/react-native`는 각각 독립적이며 서로에 대한 의존성이 없다.

3. **adapter는 host 패키지를 직접 import하지 않는다**: adapter의 소스 코드(`src/index.ts`)는 `node:child_process`, `@tauri-apps/api` 등을 import하지 않는다. 대신 호출자가 transport 객체를 생성하여 주입한다.

4. **`EngineClient`가 유일한 계약이다**: 생성된 모든 command helper는 `EngineClient` 타입만 의존한다. host adapter의 구체적 타입(`NodeEngineClient` 등)이 아닌 `EngineClient`를 통해 호출된다.

---

## 에러 모델

Rust 측은 `RustraError` 구조체로 에러를 표현한다. `Serialize`가 구현되어 있어 Tauri IPC 등에서 JSON으로 직렬화 가능하다:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RustraError {
    code: &'static str,   // "command.not_found" | "command.invalid_args" | "internal" | custom
    message: String,
}
```

**생성자:**

| 메서드                                 | 에러 코드              | 발생 조건                                                                |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `RustraError::command_not_found(name)` | `command.not_found`    | `invoke_json()`에서 명시된 이름의 command가 `Package.commands`에 없을 때 |
| `RustraError::invalid_args(error)`     | `command.invalid_args` | `serde_json::from_value` 역직렬화 실패 시                                |
| `RustraError::internal(error)`         | `internal`             | `serde_json::to_value` 직렬화 실패, I/O 에러 등                          |
| `RustraError::custom(code, message)`   | 지정한 코드            | 사용자 정의 에러                                                         |

**Getter:**

| 메서드            | 반환 타입      | 설명             |
| ----------------- | -------------- | ---------------- |
| `error.code()`    | `&'static str` | 에러 코드 조회   |
| `error.message()` | `&str`         | 에러 메시지 조회 |

`std::io::Error`는 `From` 트레이트를 통해 자동으로 `RustraError::internal`로 변환된다.

Tauri에서 `rustra_dispatch`는 `RustraError`를 JSON 값(`{ code, message }`)으로 직렬화하여 반환한다. TypeScript 측 `createTauriEngine`은 이 값을 `RustraCommandError`로 변환하여 throw한다.

---

## 빌드 및 코드 생성 워크플로우

일반적인 개발 워크플로우:

```
1. Rust 측에서 command 함수 작성
   #[command]
   fn my_command(input: MyInput) -> Result<MyOutput> { ... }

2. Package에 등록
   Package::builder("my.package")
       .command_fn(my_command)
       .build()

3. 코드 생성 실행
   let package = my_package();
   let generated = package.generate_typescript()?;
   generated.write_to_dir("./generated")?;

4. TypeScript 측에서 생성된 코드 사용
   import { myCommand } from './generated/commands.js';
   const result = await myCommand(engine, { ... });
```

`examples/calculator/src/main.rs`는 실행 시점에 코드 생성을 수행하는 예시다:

```rust
let package = calculator_package();
let generated = package.generate_typescript()?;
generated.write_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;
```

---

## 컴파일 타임 타입 안전성

`#[command]` macro는 함수 시그니처에 대한 컴파일 타임 검증을 수행한다:

1. 입력 파라미터가 최소 1개인지 확인
2. 입력 파라미터가 typed parameter인지 확인
3. 반환 타입이 `Result<O>`, bare value, 또는 `()` 형태인지 확인
4. 입력 타입이 `CommandInput` (`DeserializeOwned + JsonSchema + 'static`)을 만족하는지 정적 검증
5. 출력 타입이 `CommandOutput` (`Serialize + JsonSchema + 'static`)을 만족하는지 정적 검증

이 검증은 `__private` 모듈의 sealed 트레이트를 통해 이루어지며, public API로 노출되지 않는다. `#[command]`는 검증 외에도 `const __RUstra_meta_{fn_name}: &str` 상수를 생성하여 command 이름을 저장하며, 이 상수는 `build!` 매크로에서 참조된다.
