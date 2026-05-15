# rustra

Rust에서 명령을 한 번 정의하면, Node / Bun / Tauri / React Native 어디서든 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크.

## 작동 방식

```
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

- Rust 쪽에서 `#[command]`로 함수를 정의
- `generate_typescript()` 호출 시 타입 안전한 TS 클라이언트 코드 생성
- Node, Bun, Tauri, React Native 어댑터가 동일한 `EngineClient` 인터페이스로 라우팅

## 설치

### Rust

```toml
[dependencies]
rustra = "0.1"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

### TypeScript 어댑터 (필요한 환경만)

```bash
npm install @rustra/node      # Node.js
npm install @rustra/bun       # Bun
npm install @rustra/tauri     # Tauri
npm install @rustra/react-native  # React Native
```

## 빠른 예제

```rust
use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput { a: i64, b: i64 }

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersOutput { value: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

fn main() -> Result<()> {
    let package = Package::builder("example.calculator")
        .command_fn(add_numbers)
        .build();

    // TypeScript 클라이언트 생성
    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

```ts
// TypeScript — 모든 플랫폼에서 동일
import { createNodeEngine } from '@rustra/node';
import { addNumbers } from './generated/commands.js';

const engine = createNodeEngine({ invoke: myTransport });
const result = await addNumbers(engine, { a: 20, b: 22 }); // { value: 42 }
```

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
  crud/                    CRUD 패턴 예시 (create/get/list/update/delete)
  benchmark/               성능 벤치마크 (페이로드 확장, 처리량 측정)
  tauri-calculator/        Tauri 런타임 예시
  react-native-calculator/ React Native 런타임 예시
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

| Rust                 | TypeScript                                    |
| -------------------- | --------------------------------------------- |
| `i64`, `u32`, `f64`  | `number`                                      |
| `String`             | `string`                                      |
| `bool`               | `boolean`                                     |
| `Vec<T>`             | `T[]`                                         |
| `(A, B, C)`          | `[A, B, C]`                                   |
| `HashMap<String, T>` | `Record<string, T>`                           |
| `Option<T>`          | `T \| null` (필드가 optional이면 `?:`도 추가) |
| `enum { A, B }`      | `'A' \| 'B'`                                  |
| 구조체               | `{ field: type; ... }`                        |

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

## 성능

모든 어댑터에서 `addNumbers({ a: 42, b: 58 })` 호출 기준 (Apple Silicon, release 빌드).

| 어댑터                 | 평균 지연 | 처리량          |
| ---------------------- | --------- | --------------- |
| Rust (typed)           | 209 ns    | 5,093,309 ops/s |
| Swift → Rust FFI       | 3.5 µs    | 296,710 ops/s   |
| Bun (JS측)             | 189 ns    | ~5.3M ops/s     |
| Node.js (JS측)         | 308 ns    | ~3.3M ops/s     |
| React Native (iOS sim) | 52.5 µs   | 19,054 ops/s    |

> 상세 벤치마크, 레이어별 오버헤드 분석, 페이로드 확장성은 [벤치마크 문서](docs/benchmarks.md)를 참고.

## 에러 처리

Rust:

```rust
// 일반 에러
return Err(RustraError::custom("validation.too_large", "value exceeds limit"));

// 재시도 가능한 에러 (네트워크, 타임아웃)
return Err(RustraError::transport("connection refused"));
return Err(RustraError::timeout("request timed out"));
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

# CRUD 예시 빌드 및 TS 생성
cargo run -p rustra-crud-example --bin generate

# TypeScript 린트 / 포맷
npm run lint
npm run format:check

# Rust 린트 / 포맷
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

# CLI watch 모드 (schema 변경 시 자동 재생성)
npx rustra generate --watch --schema ./generated/schema.json --output ./src/generated
```

## 문서

전체 문서는 [`docs/`](docs/)에 있다.

| 문서                                                             | 내용                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| [시작하기](docs/getting-started.md)                              | 설치, 첫 패키지 만들기, 어댑터 선택            |
| [아키텍처 개요](docs/architecture.md)                            | 데이터 흐름, EngineClient 계약, transport 분리 |
| [Transport 교체 가이드](docs/extending/transport-guide.md)       | Bun FFI, Node napi-rs 교체                     |
| [React Native 설정 가이드](docs/extending/react-native-setup.md) | iOS JSI 모듈 설정, 사용법, 트러블슈팅          |
| [새 Host 추가 가이드](docs/extending/adding-host.md)             | Electron, Deno 등 새 어댑터 추가               |
| [전체 문서 목록](docs/README.md)                                 | 사용자 / 기여자별 읽기 경로                    |

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.
