# rustra-bridge

rustra는 Rust 패키지에서 명령을 한 번 정의하면, 호스트에 종속되지 않는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다. Rust 코드를 작성하면 Node, Bun, Tauri, React Native 어디서든 동일한 타입 안전한 클라이언트를 사용할 수 있다.

## 프로젝트 구조

```txt
crates/
  rustra/          Rust 패키지 authoring API (core)
  rustra-macros/   #[command] proc macro, register! 매크로

packages/
  node/            Node adapter
  bun/             Bun adapter
  tauri/           Tauri adapter
  react-native/    React Native adapter

examples/
  calculator/              기본 예시 (Rust crate + C FFI + stdio + 생성된 TS)
  tauri-calculator/        Tauri 런타임 예시
```

## 기본 사용법

`rustra`를 사용해 Rust 명령을 정의하면, TypeScript 클라이언트 코드가 자동으로 생성된다.

```rust
use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersOutput {
    value: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

// name 속성으로 커맨드 이름 명시 지정
#[command(name = "customName")]
fn my_function(input: Input) -> Result<Output> { ... }

fn main() -> Result<()> {
    // 개별 등록
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    // 또는 register! 매크로로 일괄 등록
    let package = rustra::register!(Package::builder("example.calculator"), add_numbers).build();

    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

`#[command]`로 함수를 등록하고, `Package::builder`에 추가한 뒤 `generate_typescript()`를 호출하면 된다. `#[command(name = "...")]`으로 커맨드 이름을 명시적으로 지정할 수도 있다. `register!` 매크로를 사용하면 여러 커맨드를 한 번에 등록할 수 있다. 입출력 구조체는 `Serialize`, `Deserialize`, `JsonSchema`를 파생해야 한다.

## Tauri 통합

`tauri` feature를 활성화하면 Tauri 앱에 바로 통합할 수 있다.

```toml
rustra = { version = "0.1", features = ["tauri"] }
```

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

`rustra_support::register`는 `rustra_dispatch` 단일 Tauri command를 등록하여, 패키지의 모든 커맨드를 동적으로 라우팅한다.

TypeScript 측에서는 `@rustra/tauri` 어댑터가 `rustra_dispatch`를 호출한다:

```ts
import { createTauriEngine } from '@rustra/tauri';

const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
const result = await addNumbers(engine, { a: 20, b: 22 });
```

## 생성된 TypeScript 클라이언트

생성된 TypeScript 코드는 모든 호스트에서 동일한 `EngineClient` 인터페이스를 사용한다.

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

type RustraError = {
  readonly code: string;
  readonly message: string;
};
```

지원하는 타입 매핑:

| Rust | TypeScript |
|------|-----------|
| `i64`, `u32`, `f64` | `number` |
| `String` | `string` |
| `bool` | `boolean` |
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` (필드가 optional이면 `?:`도 추가) |
| `enum { A, B }` | `'A' \| 'B'` |
| 구조체 | `{ field: type; ... }` |

각 어댑터(Node, Bun, Tauri, React Native)가 `EngineClient` 인터페이스를 구현하므로, 생성된 커맨드 헬퍼는 플랫폼에 관계없이 동일하게 동작한다.

## 에러 처리

`RustraError`는 구조화된 에러 코드와 메시지를 제공한다:

```rust
return Err(RustraError::custom("validation.too_large", "value exceeds limit"));
```

```ts
// Tauri 어댑터는 RustraCommandError를 throw
try {
  const result = await addNumbers(engine, { a: 1, b: 2 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code, e.message); // "validation.too_large" "value exceeds limit"
  }
}
```

## 검증

```bash
# Rust 워크스페이스 전체 테스트
cargo test --workspace

# calculator 예시 빌드 및 TS 생성
cargo run -p rustra-calculator-example
```
