# rustra

Rust 패키지를 한 번 정의하면, React Native / Node / Bun / Tauri 등 모든 호스트에서 동일하게 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크입니다.

## 의존성

```toml
[dependencies]
rustra = "0.4"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

## 사용 예시

```rust
use rustra::prelude::*;

// 입력/출력 타입 정의
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

// #[command]로 커맨드 핸들러 표시
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
        .command_fn(add_numbers)  // 이름 자동 추출 (addNumbers)
        .build();

    // 또는 register! 매크로로 여러 커맨드를 일괄 등록
    let package = rustra::register!(
        Package::builder("example.calculator"),
        add_numbers,
        my_function
    ).build();

    // 로컬에서 직접 invoke
    let output: AddNumbersOutput =
        package.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    assert_eq!(output.value, 5);

    // TypeScript 클라이언트 생성
    let generated = package.generate_typescript()?;
    generated.write_to_dir("generated")?;

    Ok(())
}
```

## API

### Package / PackageBuilder

| 메서드                              | 설명                                                          |
| ----------------------------------- | ------------------------------------------------------------- |
| `Package::builder(id)`              | `PackageBuilder` 생성                                         |
| `builder.command_fn(handler)`       | `#[command]` 함수 등록. 이름은 `type_name` 기반으로 자동 추출 |
| `builder.command(name, handler)`    | 이름을 명시적으로 지정하여 핸들러 등록                        |
| `builder.build()`                   | `Package` 생성                                                |
| `register!(builder, fn1, fn2, ...)` | 여러 `#[command]` 함수를 한 번에 등록하는 매크로              |

### RustraError

| 메서드                           | 설명                                      |
| -------------------------------- | ----------------------------------------- |
| `RustraError::custom(code, msg)` | 안정적인 코드와 메시지로 커스텀 에러 생성 |
| `error.code()`                   | 에러 코드 반환                            |
| `error.message()`                | 에러 메시지 반환                          |

`RustraError`는 `Serialize`를 구현하므로 TypeScript 측으로 직렬화되어 전달된다.

### invoke

| 메서드                                | 설명                                   |
| ------------------------------------- | -------------------------------------- |
| `package.invoke::<I, O>(name, input)` | 타입 안전한 호출. 직렬화/역직렬화 포함 |
| `package.invoke_json(name, params)`   | `serde_json::Value` 기반 호출          |

### TypeScript 생성

| 메서드                          | 설명                                                              |
| ------------------------------- | ----------------------------------------------------------------- |
| `package.generate_typescript()` | `GeneratedPackage` 반환                                           |
| `generated.write_to_dir(path)`  | `schema.json`, `types.ts`, `commands.ts`, `contract.ts` 파일 출력 |

### 생성 결과물

`generate_typescript()`는 다음 파일을 생성합니다:

- `schema.json` — 전체 패키지 스키마 (커맨드별 입력/출력 JSON Schema)
- `types.ts` — `EngineClient` 타입 + `RustraError` + 모든 입력/출력 TypeScript 타입
- `commands.ts` — 커맨드 헬퍼 함수
- `contract.ts` — `GENERATED_CONTRACT_HASH` 상수 (스키마 해시)

코드 생성은 `$ref` 해석, `anyOf` 유니온 타입, 문자열 `enum` 리터럴, `null` 타입, 타입 배열 유니온을 지원합니다.

생성된 커맨드 헬퍼 예시:

```ts
import { invokeGenerated, type InvokeOptions } from '@rustra/types';

export function addNumbers(
  input: AddNumbersInput,
  options?: InvokeOptions,
): Promise<AddNumbersOutput> {
  return invokeGenerated<AddNumbersOutput>(1, 'addNumbers', input, options);
}
```

앱 시작 시 `configure(engine)`를 한 번 호출한 뒤 생성 함수에는 입력과 선택적
취소/타임아웃 옵션만 전달한다. 숫자 command id를 지원하는 엔진은 자동으로
고속 경로를 사용하고, 구형 엔진은 이름 기반 invoke로 안전하게 폴백한다.

## 주의사항

- `command_fn`은 `std::any::type_name` 기반으로 핸들러 함수 이름을 추출합니다. 디버그 빌드에서는 전체 경로가 포함될 수 있으므로, 릴리스 빌드에서 정확한 이름이 필요한 경우 `#[command(name = "...")]` 속성을 사용하거나 `command(name, handler)`를 사용하세요.
- 모든 입력 타입은 `DeserializeOwned + JsonSchema`, 출력 타입은 `Serialize + JsonSchema`를 구현해야 합니다.

## prelude

```rust
pub use crate::{GeneratedPackage, Package, PackageBuilder, Result, RustraError, command};
pub use schemars::JsonSchema;
pub use serde::{Deserialize, Serialize};
```

## Tauri 통합 (선택 기능)

`tauri` feature를 활성화하면 Tauri 앱에 바로 통합할 수 있는 `tauri_support` 모듈이 제공됩니다:

```toml
[dependencies]
rustra = { version = "0.4", features = ["tauri"] }
```

```rust
use rustra::tauri_support::register;

let builder = register(my_package, tauri::Builder::default());
```

`register()`는 패키지의 모든 커맨드를 `rustra_dispatch` 단일 Tauri 커맨드로 라우팅하는 핸들러를 등록합니다. TypeScript 측에서 `@rustra/tauri` 어댑터를 사용하면 내부적으로 이 엔드포인트로 자동 라우팅됩니다.
