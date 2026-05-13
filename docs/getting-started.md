# rustra 시작하기

rustra는 Rust 패키지를 한 번 정의하면 Node, Bun, Tauri, React Native 어디에서나 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다.

이 가이드는 rustra를 처음 사용하는 개발자가 10분 안에 첫 패키지를 만들고 TypeScript 클라이언트를 생성하는 것을 목표로 한다.

---

## 1. 설치

### Cargo.toml 설정

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
| `rustra-macros` | `#[command]` 속성 매크로 (rustra가 자동으로 재export) |
| `serde` + `schemars` | 직렬화/역직렬화 + JSON Schema 생성. 타입에 3개 derive 필요 |

---

## 2. 최소 예제: calculator

실제 동작하는 `examples/calculator`를 기준으로 단계별로 설명한다.

### 2-1. Rust 타입 정의

입력과 출력 구조체를 정의한다. 핵심은 **세 개의 derive**와 `#[serde(rename_all = "camelCase")]`다.

```rust
use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}
```

각 derive의 역할:

- `Serialize` / `Deserialize` — serde 기반 직렬화. JSON으로 주고받으려면 필수.
- `JsonSchema` — schemars가 JSON Schema를 자동 생성. TypeScript 타입 생성의 근거가 된다.
- `#[serde(rename_all = "camelCase")]` — Rust의 `snake_case` 필드명을 TypeScript의 `camelCase`로 자동 변환. `a`와 `b`는 변환 대상이 아니지만, `my_field` 같은 필드는 `myField`가 된다.

### 2-2. 커맨드 함수

`#[command]` 매크로를 붙여 함수를 커맨드로 등록한다.

```rust
#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}
```

규칙:

- 입력 파라미터는 **정확히 1개**. 구조체로 받는다.
- 반환값은 `Result<O>` 형태여야 한다. `rustra::prelude::Result`를 사용.
- 함수명 `add_numbers`는 자동으로 camelCase 커맨드명 `addNumbers`로 변환된다.

#### 커맨드 이름 직접 지정

`name` 속성으로 커맨드 이름을 직접 지정할 수 있다. 지정하지 않으면 함수명에서 `snake_to_lower_camel` 변환으로 자동 생성된다.

```rust
#[command(name = "customName")]
pub fn my_function(input: MyInput) -> Result<MyOutput> {
    // 커맨드명: "customName"
    Ok(MyOutput { /* ... */ })
}
```

### 2-3. Package builder

여러 커맨드를 하나의 패키지로 묶는다.

#### 개별 등록 방식

```rust
pub fn calculator_package() -> Package {
    Package::builder("examples.calculator")
        .command_fn(add_numbers)
        .build()
}
```

- `Package::builder("examples.calculator")` — 패키지 식별자. 생성된 `schema.json`에 `packageId`로 기록된다.
- `.command_fn(add_numbers)` — 함수를 커맨드로 등록. 커맨드명은 `#[command]` 매크로의 `name` 속성 또는 함수명에서 자동 추출된다.
- `.command("customName", handler)` — 이름을 직접 지정할 수도 있다.
- `.build()` — `Package` 인스턴스 생성.

#### `register!` 매크로로 일괄 등록

여러 커맨드를 한 번에 등록할 때 `register!` 매크로를 사용할 수 있다. `Package::builder()`와 함께 커맨드 함수들을 나열하면 된다.

```rust
use rustra::prelude::*;

fn main() -> Result<()> {
    let package = rustra::register!(Package::builder("my.pkg"), add_numbers, multiply)
        .build();

    // TypeScript 생성
    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

`register!`는 첫 번째 인자로 `PackageBuilder`를 받고, 이후 나열된 함수들을 `.command_fn()`으로 차례대로 등록한다. 각 함수에는 `#[command]` 매크로가 적용되어 있어야 한다.

### 2-4. TypeScript 생성

`main.rs`에서 패키지를 빌드하고 TypeScript를 출력한다.

```rust
use rustra_calculator_example::{calculator_package, AddNumbersInput, AddNumbersOutput};

fn main() -> rustra::Result<()> {
    let package = calculator_package();

    // Rust 내에서 직접 호출도 가능
    let output: AddNumbersOutput = package.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", output.value);

    // TypeScript 클라이언트 생성
    let generated = package.generate_typescript()?;
    generated.write_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;

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
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};
```

- `EngineClient` — 모든 호스트 어댑터가 구현해야 하는 공통 인터페이스. `invoke` 하나만 있다.
- Rust의 `i64`는 TypeScript `number`로 매핑된다.
- `#[serde(rename_all = "camelCase")]` 덕분에 필드명이 자동으로 camelCase로 변환된다.
- **이 파일은 어떤 호스트별 의존성도 포함하지 않는다.** `node:`, `bun:`, `@tauri-apps`, `react-native` 같은 import가 없다.

### commands.ts — 커맨드 헬퍼 함수

```ts
import type { AddNumbersInput, AddNumbersOutput, EngineClient } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}
```

- 각 `#[command]` 함수마다 TypeScript 함수가 하나씩 생성된다.
- `engine` 파라미터로 `EngineClient`를 받아 `invoke`를 호출한다.
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
      "outputType": "AddNumbersOutput",
      "inputSchema": {
        "type": "object",
        "properties": { "a": { "type": "integer", "format": "int64" }, "b": { "type": "integer", "format": "int64" } },
        "required": ["a", "b"]
      },
      "outputSchema": {
        "type": "object",
        "properties": { "value": { "type": "integer", "format": "int64" } },
        "required": ["value"]
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
console.log(result.value); // 42
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
console.log(result.value); // 42
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
    let builder = tauri_support::register(my_package(), tauri::Builder::default());
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

## 요약: 전체 흐름

```
Rust 타입 정의 (Serialize + Deserialize + JsonSchema)
        |
        v
#[command] 함수 작성 (name 속성으로 커맨드명 직접 지정 가능)
        |
        v
Package::builder("id").command_fn(fn).build()
또는 register!(Package::builder("id"), fn1, fn2, ...).build()
        |
        v
package.generate_typescript()?.write_to_dir("generated")
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
