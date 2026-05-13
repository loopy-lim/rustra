# rustra

Rust에서 명령을 한 번 정의하면, 어디서든 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크.

## 작동 방식

```
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

- Rust 쪽에서 `#[command]`로 함수를 정의
- `generate_typescript()` 호출 시 타입 안전한 TS 클라이언트 코드 생성
- Node, Bun, Tauri, React Native 어댑터가 동일한 `EngineClient` 인터페이스로 라우팅

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

## Rust: 명령 정의

```rust
use rustra::prelude::*;

// 입출력 구조체는 Serialize, Deserialize, JsonSchema를 파생
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

// #[command]로 등록
#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

// 이름을 명시적으로 지정할 수도 있음
#[command(name = "customName")]
fn my_function(input: Input) -> Result<Output> { ... }
```

패키지를 빌드하고 TypeScript 코드를 생성:

```rust
fn main() -> Result<()> {
    // 개별 등록
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    // 또는 register! 매크로로 여러 커맨드를 한 번에 등록
    let package = rustra::register!(Package::builder("example.calculator"), add_numbers).build();

    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

## TypeScript: 생성된 클라이언트

모든 플랫폼에서 동일한 인터페이스:

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

type RustraError = {
  readonly code: string;
  readonly message: string;
};
```

### 타입 매핑

| Rust | TypeScript |
|------|-----------|
| `i64`, `u32`, `f64` | `number` |
| `String` | `string` |
| `bool` | `boolean` |
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` (필드가 optional이면 `?:`도 추가) |
| `enum { A, B }` | `'A' \| 'B'` |
| 구조체 | `{ field: type; ... }` |

각 어댑터가 `EngineClient`를 구현하므로, 생성된 커맨드 헬퍼는 플랫폼에 관계없이 동일하게 동작한다.

## 플랫폼 어댑터

### Tauri

`tauri` feature를 활성화:

```toml
rustra = { version = "0.1", features = ["tauri"] }
```

Rust 측:

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

TypeScript 측:

```ts
import { createTauriEngine } from '@rustra/tauri';

const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
const result = await addNumbers(engine, { a: 20, b: 22 });
```

### Node / Bun / React Native

각 패키지(`@rustra/node`, `@rustra/bun`, `@rustra/react-native`)에서 `EngineClient` 구현체를 제공한다. 사용 방식은 Tauri와 동일하다.

## 에러 처리

Rust:

```rust
return Err(RustraError::custom("validation.too_large", "value exceeds limit"));
```

TypeScript:

```ts
try {
  const result = await addNumbers(engine, { a: 1, b: 2 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code, e.message); // "validation.too_large" "value exceeds limit"
  }
}
```

## 개발

```bash
# Rust 워크스페이스 전체 테스트
cargo test --workspace

# calculator 예시 빌드 및 TS 생성
cargo run -p rustra-calculator-example
```
