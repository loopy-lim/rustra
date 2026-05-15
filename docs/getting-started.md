# rustra 시작하기

rustra는 Rust 패키지를 한 번 정의하면 Node, Bun, Tauri, React Native 어디에서나 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다.

이 가이드는 rustra를 처음 사용하는 개발자가 10분 안에 첫 패키지를 만들고 TypeScript 클라이언트를 생성하는 것을 목표로 한다.

---

## 1. 설치

### 외부 프로젝트에서 사용

```toml
[dependencies]
rustra = "0.1"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

TypeScript 어댑터는 사용할 환경만 설치하면 된다:

```bash
npm install @rustra/node      # Node.js
npm install @rustra/bun       # Bun
npm install @rustra/tauri     # Tauri
npm install @rustra/react-native  # React Native
```

### 모노레포 / workspace에서 사용

rustra는 workspace 기반으로 관리하는 것이 권장된다. 최상위 `Cargo.toml`에 다음 의존성을 추가한다.

```toml
[workspace.dependencies]
rustra = { path = "crates/rustra" }
rustra-macros = { path = "crates/rustra-macros" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = { version = "0.8", features = ["derive"] }
sha2 = "0.10"
hex = "0.4"
```

그리고 실제 패키지 크레이트(예: `examples/calculator/Cargo.toml`)에서 workspace 의존성을 가져온다.

```toml
[package]
name = "rustra-calculator-example"
edition.workspace = true
version.workspace = true
publish = false

[lib]
crate-type = ["rlib", "staticlib"]

[dependencies]
rustra.workspace = true
schemars.workspace = true
serde.workspace = true
serde_json.workspace = true
```

필요한 crate는 4개뿐이다.

| crate | 역할 |
|-------|------|
| `rustra` | Package builder, TypeScript 생성기, JSON Schema 기반 타입 매핑 |
| `rustra-macros` | `#[command]`, `#[bridge_type]`, `build!` 매크로 (rustra가 자동으로 재export) |
| `serde` + `schemars` | 직렬화/역직렬화 + JSON Schema 생성 |

---

## 2. 최소 예제: calculator

실제 동작하는 `examples/calculator`를 기준으로 단계별로 설명한다.

### 2-1. 커맨드 정의

rustra는 두 가지 방식으로 커맨드를 정의할 수 있다.

#### 방식 A: 스칼라 파라미터 (가장 간단)

입출력 구조체를 정의할 필요 없이, 함수 파라미터와 반환값만 작성하면 된다.

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(a: i64, b: i64) -> i64 {
    a + b
}
```

`#[command]` 매크로가 자동으로:
- Input struct를 생성하고 `#[serde(rename_all = "camelCase")]`를 적용
- 반환값을 `Ok()`로 래핑
- TypeScript에 `AddNumbersInput` 타입으로 노출

#### 방식 B: 커스텀 타입 사용

복잡한 입력이 필요하면 `#[bridge_type]`으로 구조체를 정의한다.

```rust
use rustra::prelude::*;

#[bridge_type]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}

#[bridge_type]
struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[command]
fn find_user(query: UserQuery) -> Result<User> {
    Ok(User {
        id: "1".into(),
        name: query.name,
        email: format!("{}@example.com", query.name.to_lowercase()),
    })
}
```

`#[bridge_type]`은 `Debug + Serialize + Deserialize + JsonSchema` derive와 `#[serde(rename_all = "camelCase")]`를 하나로 합친 것이다.

### 2-2. 커맨드 함수 규칙

`#[command]` 매크로는 파라미터 개수에 따라 모드를 자동 선택한다.

| 파라미터 수 | 모드 | 설명 |
|------------|------|------|
| 0개 | 에러 | 최소 1개 필요 |
| 1개 | 구조체 모드 | 단일 구조체 타입을 직접 받음 |
| 2개 이상 | 스칼라 모드 | Input struct를 자동 생성 |

세 가지 반환 패턴을 지원한다:

```rust
// 1. 스칼라 반환 — 자동 Ok() 래핑
#[command]
fn add(a: i64, b: i64) -> i64 { a + b }

// 2. Result 반환 — 에러 처리 가능
#[command]
fn divide(a: i64, b: i64) -> Result<i64> {
    if b == 0 { return Err(RustraError::custom("division.by_zero", "cannot divide by zero")); }
    Ok(a / b)
}

// 3. 구조체 파라미터 + Result 반환
#[command]
fn find_user(query: UserQuery) -> Result<User> { ... }
```

#### 커맨드 이름 직접 지정

`name` 속성으로 커맨드 이름을 직접 지정할 수 있다. 지정하지 않으면 함수명에서 `snake_to_lower_camel` 변환으로 자동 생성된다.

```rust
#[command(name = "customName")]
fn my_function(input: MyInput) -> Result<MyOutput> {
    Ok(MyOutput { /* ... */ })
}
```

### 2-3. 패키지 등록 및 TypeScript 생성

`rustra::build!()` 매크로로 등록과 TypeScript 생성을 한 번에 처리한다.

```rust
fn main() -> Result<()> {
    // 등록 + TypeScript 생성
    rustra::build!("examples.calculator", add_numbers)
        .generate_to("generated")?;

    Ok(())
}
```

여러 커맨드를 등록할 때:

```rust
rustra::build!("examples.calculator", add_numbers, multiply, divide)
    .generate_to("generated")?
```

런타임에서 커맨드를 호출해야 할 때는 `.done()`으로 `Package`를 얻는다:

```rust
let pkg = rustra::build!("examples.calculator", add_numbers)
    .done();

let result: i64 = pkg.invoke("addNumbers", json!({ "a": 2, "b": 3 }))?;
println!("2 + 3 = {result}");
```

### 2-4. 전체 예제

`main.rs`에서 패키지를 빌드하고 TypeScript를 출력한다.

```rust
use rustra_calculator_example::add_numbers;

fn main() -> rustra::Result<()> {
    // 런타임 호출
    let pkg = rustra::build!("examples.calculator", add_numbers).done();
    let result: i64 = pkg.invoke("addNumbers", json!({ "a": 2, "b": 3 }))?;
    println!("2 + 3 = {result}");

    // TypeScript 클라이언트 생성
    rustra::build!("examples.calculator", add_numbers)
        .generate_to(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;

    Ok(())
}
```

실행:

```bash
cargo run -p rustra-calculator-example
```

출력:

```
2 + 3 = 5
```

그리고 `generated/` 디렉토리에 4개 파일이 생성된다.

---

## 3. 생성된 TypeScript 결과물

`generated/` 디렉토리에는 다음 4개 파일이 생성된다.

### types.ts — 타입 정의

```ts
export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AddNumbersInput = {
  a: number;
  b: number;
};
```

- `EngineClient` — 모든 호스트 어댑터가 구현해야 하는 공통 인터페이스. `invoke` 하나만 있다.
- Rust의 `i64`는 TypeScript `number`로 매핑된다.
- 스칼라 반환 타입은 type alias 없이 직접 `number`로 사용된다.
- **이 파일은 어떤 호스트별 의존성도 포함하지 않는다.** `node:`, `bun:`, `@tauri-apps`, `react-native` 같은 import가 없다.

### commands.ts — 커맨드 헬퍼 함수

```ts
import type { AddNumbersInput, EngineClient } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<number> {
  return engine.invoke<number>('addNumbers', input);
}
```

- 각 `#[command]` 함수마다 TypeScript 함수가 하나씩 생성된다.
- `engine` 파라미터로 `EngineClient`를 받아 `invoke`를 호출한다.
- 스칼라 반환은 `Promise<number>`처럼 직접 inline된다.
- 커맨드명(`addNumbers`), 입력 타입, 출력 타입이 모두 타입 안전하게 연결된다.

### contract.ts — 계약 해시

```ts
export const GENERATED_CONTRACT_HASH = '5ed9d6dc29fb1b0d437b110a8f48e0cb828cc1e27a562b79049e86975b970aba';
```

- 스키마 전체를 SHA-256으로 해시한 값.
- Rust 쪽과 TypeScript 쪽이 같은 계약 버전을 공유하는지 런타임에 검증할 때 사용.

### schema.json — JSON Schema

```json
{
  "commands": [
    {
      "name": "addNumbers",
      "inputType": "AddNumbersInput",
      "outputType": "i64",
      "inputSchema": {
        "type": "object",
        "properties": { "a": { "type": "integer", "format": "int64" }, "b": { "type": "integer", "format": "int64" } },
        "required": ["a", "b"]
      },
      "outputSchema": {
        "type": "integer",
        "format": "int64"
      }
    }
  ],
  "packageId": "examples.calculator"
}
```

- schemars가 생성한 JSON Schema. 런타임 검증, 문서 자동화, 외부 도구 연동에 활용.

---

## 4. 어댑터 선택 가이드

생성된 TypeScript 코드는 호스트에 종속되지 않는다. 실제 환경에서는 어댑터를 통해 `EngineClient`를 생성해서 `commands.ts`의 함수에 넘겨주면 된다.

rustra는 4개의 공식 어댑터 패키지를 제공한다.

### Node

```ts
import { createNodeEngine } from '@rustra/node';
import { addNumbers } from '../generated/commands.js';

const engine = createNodeEngine({
  invoke(command, args) {
    // Rust 런타임 프로세스를 호출하는 등의 transport 구현
    return invokeCalculatorRuntime(command, args);
  },
});

const result = await addNumbers(engine, { a: 20, b: 22 });
console.log(result); // 42
```

`createNodeEngine`은 `{ invoke(command, args) }` 형태의 transport 객체를 받아 `EngineClient`를 반환한다.

### Bun

```ts
import { createBunEngine } from '@rustra/bun';
import { addNumbers } from '../generated/commands.js';

const engine = createBunEngine({
  invoke(command, args) {
    return invokeCalculatorRuntime(command, args);
  },
});

const result = await addNumbers(engine, { a: 20, b: 22 });
console.log(result); // 42
```

Node 어댑터와 동일한 형태. transport만 Bun 환경에 맞게 구현.

### Tauri

```ts
import { createTauriEngine } from '@rustra/tauri';
import { addNumbers } from '../generated/commands.js';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const engine = createTauriEngine({
  invoke: tauriInvoke,
});

const result = await addNumbers(engine, { a: 20, b: 22 });
```

Tauri 어댑터는 내부적으로 모든 커맨드를 `rustra_dispatch` 단일 엔드포인트로 멀티플렉싱한다. `createTauriEngine`은 각 커맨드 호출을 `invoke('rustra_dispatch', { command, args })` 형태로 래핑한다.

Rust 쪽에서는 `rustra::tauri_support::register`로 패키지를 Tauri 빌더에 한 줄로 등록한다.

```rust
// Tauri 앱 main.rs
use rustra::tauri_support;

fn main() {
    let pkg = rustra::build!("my.app", command1, command2).done();
    let builder = tauri_support::register(pkg, tauri::Builder::default());
    builder.run(tauri::generate_context!()).expect("failed to run");
}
```

> **참고:** `tauri_support`를 사용하려면 `Cargo.toml`에서 `tauri` feature를 활성화해야 한다.
>
> ```toml
> rustra = { path = "...", features = ["tauri"] }
> ```

### React Native

```ts
import { createReactNativeEngine } from '@rustra/react-native';
import { addNumbers } from '../generated/commands.js';
import { RustraCalculatorModule } from './native-modules';

const engine = createReactNativeEngine(RustraCalculatorModule);

const result = await addNumbers(engine, { a: 20, b: 22 });
```

`createReactNativeEngine`은 `NativeModules.RustraCalculator` 같은 네이티브 모듈을 받아 `EngineClient`를 반환한다. 네이티브 모듈은 `invoke(command, args)` 메서드를 노출해야 한다.

### 요약

| 환경 | 어댑터 함수 | transport 인자 |
|------|------------|----------------|
| Node | `createNodeEngine(transport)` | `{ invoke(command, args) }` |
| Bun | `createBunEngine(transport)` | `{ invoke(command, args) }` |
| Tauri | `createTauriEngine(options)` | `{ invoke: tauriInvoke }` |
| React Native | `createReactNativeEngine(nativeModule)` | `NativeModule` (`invoke` 메서드 포함) |

모든 어댑터가 `EngineClient`를 반환하므로, 이후 코드는 환경에 상관없이 동일하다.

```ts
// 어댑터만 다르고, 나머지는 모두 같은 코드
const result = await addNumbers(engine, { a: 20, b: 22 });
```

---

## 5. 실행 및 테스트

### Rust 테스트

```bash
cargo test --workspace
```

모든 크레이트의 유닛 테스트를 실행한다.

### TypeScript 생성 확인

```bash
cargo run -p rustra-calculator-example
```

`generated/` 디렉토리에 TypeScript 파일이 생성되었는지 확인한다.

### 전체 호환성 테스트

```bash
npm run test:compat
```

이 명령어는 다음을 모두 실행한다.

| 스크립트 | 내용 |
|---------|------|
| `test:ts:node` | Node로 생성된 클라이언트 타입 검증 |
| `test:ts:bun` | Bun으로 생성된 클라이언트 타입 검증 |
| `test:adapters` | 4개 어댑터가 모두 동일한 커맨드를 올바르게 전달하는지 확인 |
| `test:runtime` | Node, Bun 런타임에서 실제 Rust 프로세스 호출, Tauri 앱 빌드 및 WebView에서 호출 검증 |

개별 실행도 가능하다.

```bash
# 어댑터만 테스트
npm run test:adapters

# Node 런타임만 테스트 (Rust 빌드 포함)
npm run test:runtime:node

# Tauri 런타임만 테스트
npm run test:runtime:tauri
```

---

## 6. 생성된 TypeScript를 프로젝트에 통합하기

코드 생성 후 TypeScript 프로젝트에서 생성된 파일을 사용하는 방법.

### 디렉토리 구성 예시

```
my-app/
├── rust-core/            # Rust 패키지 (rustra 사용)
│   ├── Cargo.toml
│   ├── src/lib.rs
│   └── generated/        ← rustra가 여기에 TS 생성
│       ├── types.ts
│       ├── commands.ts
│       ├── contract.ts
│       └── schema.json
├── src/
│   └── app.ts            # 여기서 생성된 TS를 import
├── tsconfig.json
└── package.json
```

### tsconfig.json 설정

생성된 파일이 프로젝트 외부에 있으면 `paths`로 매핑한다:

```json
{
  "compilerOptions": {
    "paths": {
      "@generated/*": ["./rust-core/generated/*"]
    }
  }
}
```

### 빌드 파이프라인

**권장 방식: 빌드 스크립트에서 코드 생성 → TypeScript 빌드**

```json
// package.json
{
  "scripts": {
    "build:rust": "cargo build -p my-package && cargo run -p my-package -- generate",
    "build:ts": "tsc",
    "build": "npm run build:rust && npm run build:ts",
    "dev": "npm run build:rust && tsc --watch"
  }
}
```

`cargo run`에서 `generate` 서브커맨드를 처리하도록 `main.rs`를 작성하면 된다:

```rust
fn main() -> rustra::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("generate") {
        rustra::build!("my.package", add_numbers, multiply)
            .generate_to("generated")?;
    }
    Ok(())
}
```

### CI에서 계약 검증

생성된 파일이 Rust 코드와 동기화되어 있는지 확인하려면:

```bash
# 기존 생성 파일을 백업, 재생성 후 diff
cargo run -p my-package -- generate
git diff --exit-code generated/
```

`git diff --exit-code`가 0이 아니면 Rust 코드는 바뀌었는데 TS 파일이 갱신되지 않은 것이다. CI에서 이 검사를 넣으면 계약 불일치를 사전에 발견할 수 있다.

---

## 7. 에러 처리

### Rust 측

`RustraError`로 에러를 반환한다. `Serialize`가 구현되어 있어 JSON으로 직렬화된다.

```rust
use rustra::prelude::*;

#[command]
fn divide(a: i64, b: i64) -> Result<i64> {
    if b == 0 {
        return Err(RustraError::custom("division.by_zero", "cannot divide by zero"));
    }
    Ok(a / b)
}
```

에러 코드 종류:

| 에러 코드 | 발생 조건 |
|----------|----------|
| `command.not_found` | 존재하지 않는 커맨드 호출 |
| `command.invalid_args` | 입력 JSON 역직렬화 실패 |
| `internal` | 내부 오류 (직렬화 실패, I/O 등) |
| custom (지정한 코드) | `RustraError::custom(code, message)` |

### TypeScript 측

커맨드 호출이 실패하면 어댑터가 에러를 throw한다. Tauri 어댑터는 `RustraCommandError` 클래스를 제공한다:

```ts
import { RustraCommandError } from '@rustra/tauri';

try {
  const result = await divide(engine, { a: 10, b: 0 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code);    // "division.by_zero"
    console.log(e.message); // "cannot divide by zero"
  }
}
```

Node, Bun, React Native 어댑터는 transport 구현에 따라 에러 형태가 달라진다. 공통적으로 에러 응답은 `{ ok: false, error: { code, message } }` 형태의 JSON이다.

---

## 8. TypeScript 타입 매핑 한계

대부분의 Rust 타입이 TypeScript로 올바르게 변환되지만, 현재 다음 타입은 `unknown`으로 폴백된다:

| 미지원 타입 | 이유 |
|------------|------|
| `tuple` (`(A, B)`) | `prefixItems` 미처리 |
| `oneOf` | `anyOf`만 처리 |
| `allOf` | 교차 타입(intersection) 미처리 |
| integer enum | string enum만 리터럴 union 변환 |
| 중첩 `$ref` (다단계) | 1단계까지만 해석 |

이런 타입이 필요하면 `types.ts`를 직접 수정하거나, `#[command(name = "...")]`으로 명시적 이름을 지정하는 방식으로 우회할 수 있다.

---

## 요약: 전체 흐름

```
Rust #[command] 함수 작성
(스칼라 파라미터 또는 #[bridge_type] 구조체)
        |
        v
rustra::build!("id", fn1, fn2, ...)
    .generate_to("generated")?    ← 등록 + TypeScript 생성
        |
        v
generated/
  types.ts       -- EngineClient + 입력/출력 타입
  commands.ts    -- 타입 안전한 커맨드 헬퍼 함수
  contract.ts    -- 계약 해시
  schema.json    -- JSON Schema
        |
        v
TypeScript에서 createXxxEngine(transport) + addNumbers(engine, input) 호출
```
