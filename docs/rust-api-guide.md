# rustra-bridge Rust API 가이드

## 1. 개요

rustra-bridge는 Rust에서 명령을 한 번 정의하면, Node / Bun / Tauri / React Native 어디서든 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크입니다.

```text
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

핵심 구성 요소는 세 가지입니다:

| 구성 요소          | 역할                                                   |
| ------------------ | ------------------------------------------------------ |
| `#[command]`       | 함수를 브릿지 명령으로 변환하는 속성 매크로            |
| `#[bridge_type]`   | 구조체/열거형에 필요한 derive와 serde 설정을 자동 추가 |
| `rustra::build!()` | 패키지 빌더를 생성하고 여러 명령을 한 번에 등록        |

---

## 2. `#[command]` 매크로

함수를 rustra-bridge 명령으로 변환하는 속성 매크로입니다. `#[command]` 또는 `#[command(name = "customName")]` 형태로 사용합니다.

### 2-1. 스칼라 파라미터 모드 (2개 이상 파라미터)

파라미터가 2개 이상이면 매크로가 자동으로 Input 구조체를 생성합니다.

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(a: i64, b: i64) -> i64 {
    a + b
}
```

매크로가 내부적으로 생성하는 코드:

```rust
// 원본 함수 그대로 유지
fn add_numbers(a: i64, b: i64) -> i64 { a + b }

// 자동 생성된 Input 구조체
#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

// 자동 생성된 핸들러 (Ok() 래핑 포함)
fn __rustra_add_numbers_handler(__input: AddNumbersInput) -> rustra::Result<i64> {
    let AddNumbersInput { a, b } = __input;
    Ok(add_numbers(a, b))
}
```

주요 특징:

- 자동 생성된 Input 구조체에 `#[serde(rename_all = "camelCase")]`가 적용됩니다.
- 반환값이 bare 타입(`i64`, `String` 등)이면 핸들러가 자동으로 `Ok()`로 래핑합니다.
- TypeScript에서 `AddNumbersInput` 타입으로 노출됩니다.

### 2-2. 구조체 파라미터 모드 (1개 파라미터)

파라미터가 1개이면 직접 정의한 구조체를 입력 타입으로 사용합니다.

```rust
#[command]
fn find_user(input: UserQuery) -> Result<User> {
    // ...
}
```

이 모드에서는 Input 구조체를 자동 생성하지 않고, 개발자가 직접 정의한 타입을 그대로 사용합니다. `#[bridge_type]`과 함께 사용하면 보일러플레이트를 최소화할 수 있습니다.

```rust
#[bridge_type]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}

#[bridge_type]
struct User {
    pub id: String,
    pub display_name: String,
}

#[command]
fn find_user(input: UserQuery) -> Result<User> {
    Ok(User {
        id: "123".into(),
        display_name: input.name,
    })
}
```

### 2-3. 반환 타입

세 가지 반환 패턴을 지원합니다:

| 패턴        | Rust 시그니처       | 동작                        |
| ----------- | ------------------- | --------------------------- |
| bare 반환   | `-> i64`            | 핸들러가 `Ok()`로 자동 래핑 |
| Result 반환 | `-> Result<i64>`    | Result를 그대로 전달        |
| unit 반환   | `-> ()` (또는 생략) | `Ok(())`로 래핑             |

```rust
// Pattern 1: bare 반환
#[command]
fn add(a: i64, b: i64) -> i64 {
    a + b
}

// Pattern 2: Result 반환
#[command]
fn divide(a: i64, b: i64) -> Result<i64> {
    if b == 0 {
        return Err(RustraError::invalid_args("division by zero"));
    }
    Ok(a / b)
}

// Pattern 3: unit 반환
#[command]
fn log_event(event: String) {
    println!("event: {event}");
}
```

### 2-4. 커맨드 이름 규칙

함수 이름은 자동으로 lowerCamelCase로 변환됩니다:

| 함수 이름              | 커맨드 이름                                 |
| ---------------------- | ------------------------------------------- |
| `add_numbers`          | `addNumbers`                                |
| `find_user`            | `findUser`                                  |
| `do_something_command` | `doSomething` (`_command` 접미사 자동 제거) |

직접 지정하려면 `name` 속성을 사용합니다:

```rust
#[command(name = "calc.add")]
fn add_numbers(a: i64, b: i64) -> i64 {
    a + b
}
```

### 2-5. 컴파일 타임 검증

`#[command]` 매크로는 컴파일 타임에 다음을 검증합니다:

**파라미터 개수 검증** — 파라미터가 0개이면 컴파일 에러가 발생합니다:

```rust,compile_fail
#[command]
fn no_args() -> Result<()> { // 에러: 최소 하나의 파라미터 필요
    Ok(())
}
```

**trait bound 검증** — 입출력 타입이 필요한 trait을 충족하는지 확인합니다:

- 입력 타입: `DeserializeOwned + JsonSchema`
- 출력 타입: `Serialize + JsonSchema`

trait bound를 충족하지 않으면 `#[diagnostic::on_unimplemented]`를 통해 친절한 에러 메시지를 출력합니다:

```text
error: `MyType` cannot be used as a command parameter
  --> src/main.rs:5:1
   |
5  | #[command]
   | ^^^^^^^^^ command parameters require Serialize + Deserialize + JsonSchema
   |
   = note: add `#[rustra::bridge_type]` to `MyType`
```

---

## 3. `#[bridge_type]` 속성

구조체나 열거형에 필요한 derive와 serde 설정을 한 줄로 추가합니다.

```rust
#[bridge_type]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}
```

위 코드는 다음과 동일합니다:

```rust
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UserQuery {
    pub name: String,
    pub age: Option<u32>,
}
```

자동 추가되는 항목:

- `#[derive(Debug, Serialize, Deserialize, JsonSchema)]`
- `#[serde(rename_all = "camelCase")]`

### 오버라이드

`#[bridge(rename_all = "...")]`로 기본 `camelCase`를 변경할 수 있습니다:

```rust
#[bridge_type]
#[bridge(rename_all = "snake_case")]
struct RawQuery {
    pub field_name: String, // JSON에서 "field_name"으로 유지
}
```

이미 `#[serde(rename_all = "...")]`가 있으면 그 값을 우선합니다:

```rust
#[bridge_type]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct Constants {
    pub max_value: i64, // JSON에서 "MAX_VALUE"로 직렬화
}
```

### 열거형에도 사용 가능

```rust
#[bridge_type]
enum Status {
    Active,
    Inactive,
}
```

TypeScript에서 유니온 타입으로 생성됩니다:

```typescript
export type Status = 'Active' | 'Inactive';
```

데이터를 가진 열거형도 지원됩니다:

```rust
#[bridge_type]
enum Shape {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
}
```

---

## 4. `rustra::build!()` 매크로

패키지 빌더를 생성하고 `#[command]` 함수들을 한 번에 등록하는 매크로입니다.

### 기본 사용법

```rust
// 등록 + TypeScript 생성
rustra::build!("examples.calculator", add_numbers, multiply)
    .generate_to("generated")?;

// 런타임 전용 Package
let pkg = rustra::build!("examples.calculator", add_numbers)
    .done();
```

### 매크로 내부 동작

`rustra::build!("examples.calculator", add_numbers)` 호출 시 다음 코드로 확장됩니다:

```rust
rustra::Package::builder("examples.calculator")
    .command(__RUstra_meta_add_numbers, __rustra_add_numbers_handler)
```

각 `#[command]` 함수에 대해 매크로가 생성하는 것:

| 생성물           | 이름 규칙                    | 역할                                            |
| ---------------- | ---------------------------- | ----------------------------------------------- |
| 메타데이터 상수  | `__RUstra_meta_<fn_name>`    | 커맨드 이름을 저장하는 `&str` 상수              |
| 핸들러 함수      | `__rustra_<fn_name>_handler` | 입력 타입 변환과 Ok() 래핑을 수행하는 래퍼 함수 |
| trait bound 검증 | `_check_command_bounds`      | 입출력 타입이 필요한 trait을 충족하는지 확인    |

---

## 5. PackageBuilder 메서드

`PackageBuilder`는 명령을 점진적으로 등록하는 빌더입니다. `Package::builder(id)` 또는 `rustra::build(id)`로 생성합니다.

### `.register(handler)` / `.command_fn(handler)`

`#[command]` 함수를 이름 자동 추론으로 등록합니다. 두 메서드는 동일한 동작을 수행합니다.

```rust
let pkg = rustra::build("example.calculator")
    .register(add_numbers)
    .done();
```

함수 이름에서 `_command` 접미사를 제거한 뒤 lowerCamelCase로 변환하여 커맨드 이름으로 사용합니다.

### `.command(name, handler)`

이름을 직접 지정하여 등록합니다.

```rust
let pkg = rustra::build("example.calculator")
    .command("calc.add", __rustra_add_numbers_handler)
    .done();
```

같은 이름의 명령이 이미 등록되어 있으면 패닉이 발생합니다.

### `.done()` / `.build()`

등록된 모든 명령을 불변 `Package`로 빌드합니다. `.done()`은 `.build()`의 별칭입니다.

```rust
let pkg = rustra::build("example.calculator")
    .register(add_numbers)
    .done();
```

### `.generate_to(dir)`

빌드 + TypeScript 생성 + 파일 저장을 한 번에 수행하는 편의 메서드입니다.

```rust
rustra::build!("examples.calculator", add_numbers)
    .generate_to("../generated")?;
```

내부적으로 `.build()` → `.generate_typescript()` → `.write_to_dir()`을 순차적으로 호출합니다.

---

## 6. Package 메서드

`Package`는 등록된 명령 집합을 나타내는 불변 타입입니다. 내부적으로 `Arc` 기반이므로 저비용으로 복제할 수 있습니다.

### `.invoke::<I, O>(name, input)`

타입 안전한 명령 호출입니다.

```rust
let output: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
println!("Result: {}", output.value);
```

제네릭 파라미터:

- `I: Serialize` — 입력 타입
- `O: DeserializeOwned` — 출력 타입

### `.invoke_json(name, params)`

JSON `Value`를 직접 전달하는 비제네릭 호출입니다. JSON 기반 라우팅에 적합합니다.

```rust
use serde_json::json;

let result: Value = pkg.invoke_json("addNumbers", json!({ "a": 2, "b": 3 }))?;
```

### `.generate_typescript()`

등록된 모든 명령에서 TypeScript 클라이언트 코드를 생성합니다.

```rust
let generated = pkg.generate_typescript()?;
```

---

## 7. GeneratedPackage

TypeScript 코드 생성 결과를 담는 구조체입니다.

| 필드            | 출력 파일     | 내용                                |
| --------------- | ------------- | ----------------------------------- |
| `schema_json`   | `schema.json` | 전체 명령 스키마 (JSON)             |
| `types_ts`      | `types.ts`    | TypeScript 타입 정의                |
| `commands_ts`   | `commands.ts` | TypeScript 명령 헬퍼 함수           |
| `contract_hash` | `contract.ts` | 스키마 SHA-256 해시 (무결성 검증용) |

### `.write_to_dir(dir)`

네 개의 파일을 지정한 디렉토리에 저장합니다. 디렉토리가 없으면 생성합니다.

```rust
let generated = pkg.generate_typescript()?;
generated.write_to_dir("generated")?;
```

생성되는 파일:

```text
generated/
  schema.json      # 전체 명령 스키마
  types.ts         # TypeScript 타입 정의
  commands.ts      # TypeScript 명령 헬퍼 함수
  contract.ts      # GENERATED_CONTRACT_HASH 상수
```

---

## 8. 에러 처리

### RustraError

모든 에러는 `code`와 `message` 필드를 가집니다.

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

### 에러 코드 분류

| 코드                   | 팩토리 메서드                          | 의미                                    |
| ---------------------- | -------------------------------------- | --------------------------------------- |
| `command.not_found`    | `RustraError::command_not_found(name)` | 등록되지 않은 명령 호출                 |
| `command.invalid_args` | `RustraError::invalid_args(error)`     | 입력 인자 역직렬화 실패                 |
| `capability.denied`    | `RustraError::capability_denied(d)`    | capability 미부여                       |
| `transport.error`      | `RustraError::transport(error)`        | transport/네트워크 오류 — **retryable** |
| `transport.timeout`    | `RustraError::timeout(error)`          | 타임아웃 — **retryable**                |
| `internal`             | `RustraError::internal(error)`         | 내부 오류 (직렬화, I/O 등)              |
| (커스텀)               | `RustraError::custom(code, message)`   | 사용자 정의 에러                        |

### 재시도 가능 여부 (retryable)

`transport.error`/`transport.timeout` 생성 에러는 `retryable: true`로 설정된다.
임의의 에러에 `.retryable()` 빌더를 붙일 수 있고, `is_retryable()`로 조회한다:

```rust
let err = RustraError::custom("db.locked", "retry later").retryable();
assert!(err.is_retryable());
```

TypeScript 측 `RustraCommandError`는 `.retryable` 필드로 같은 값을 노출한다
(와이어에 플래그가 없는 JSON 경로에서는 `transport.*` 코드 기반으로 추론).

### 에러 메서드

```rust
let err = RustraError::custom("auth.unauthorized", "invalid token");
assert_eq!(err.code(), "auth.unauthorized");
assert_eq!(err.message(), "invalid token");
```

### Result 타입

`rustra::prelude::Result<T>`는 `std::result::Result<T, RustraError>`의 별칭입니다.

```rust
use rustra::prelude::*;

fn my_function() -> Result<String> {
    Ok("hello".into())
}
```

### std::io::Error 자동 변환

`From<std::io::Error>`가 구현되어 있어 `?` 연산자로 자연스럽게 전파할 수 있습니다:

```rust
fn write_output() -> Result<()> {
    std::fs::write("output.txt", "hello")?; // io::Error → RustraError(internal)
    Ok(())
}
```

---

## 9. TypeScript 생성 규칙

### 타입 매핑

| Rust 타입                     | TypeScript 타입                         |
| ----------------------------- | --------------------------------------- |
| `i64`, `i32`, `u32`, `f64` 등 | `number`                                |
| `String`                      | `string`                                |
| `bool`                        | `boolean`                               |
| `Option<T>`                   | `T \| null` (구조체 필드는 `?:` 선택적) |
| `Vec<T>`                      | `T[]`                                   |
| `Vec<Vec<T>>`                 | `T[][]` (중첩 지원)                     |
| `HashMap<String, V>`          | `Record<string, V>`                     |
| `BTreeSet<T>` / `HashSet<T>`  | `Set<T>` (`uniqueItems` 매핑)           |
| `(A, B, C)`                   | `[A, B, C]` (튜플)                      |
| 단순 `enum`                   | `'Variant1' \| 'Variant2'`              |
| 데이터를 가진 `enum`          | 객체 유니온 타입                        |

### 선택적 필드 처리

```rust
struct Example {
    pub name: String,        // 필수
    pub age: Option<u32>,    // 선택적
}
```

```typescript
export type Example = {
  name: string;
  age?: number | null;
};
```

### 스칼라 반환 타입

반환값이 원시 타입(`i64`, `String`, `bool`)이면 TypeScript에서 별도 type alias 없이 직접 inline됩니다:

```rust
#[command]
fn add_numbers(a: i64, b: i64) -> i64 { a + b }
```

```typescript
export function addNumbers(input: AddNumbersInput): Promise<number> {
  return invoke<number>('addNumbers', input);
}
```

### 생성된 types.ts 예시

```typescript
export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AddNumbersInput = {
  a: number;
  b: number;
};
```

### 생성된 commands.ts 예시

```typescript
import { invoke } from '@rustra/types';
import type { AddNumbersInput } from './types.js';

export function addNumbers(input: AddNumbersInput): Promise<number> {
  return invoke<number>('addNumbers', input);
}
```

(`invoke`는 `configure(engine)`로 설치한 글로벌 엔진을 사용한다)

---

## 10. prelude

자주 사용하는 타입과 매크로를 한 번에 가져옵니다:

```rust
use rustra::prelude::*;
```

제공 항목:

| 항목               | 종류        | 용도                                  |
| ------------------ | ----------- | ------------------------------------- |
| `build`            | 함수        | `PackageBuilder` 생성                 |
| `bridge_type`      | 속성 매크로 | 구조체/열거형 derive 자동화           |
| `command`          | 속성 매크로 | 함수를 브릿지 명령으로 변환           |
| `Package`          | 구조체      | 등록된 명령 집합                      |
| `PackageBuilder`   | 구조체      | 명령 등록 빌더                        |
| `Result<T>`        | 타입 별칭   | `std::result::Result<T, RustraError>` |
| `RustraError`      | 구조체      | 에러 타입                             |
| `Serialize`        | trait       | serde 직렬화                          |
| `Deserialize`      | trait       | serde 역직렬화                        |
| `JsonSchema`       | trait       | JSON Schema 생성                      |
| `GeneratedPackage` | 구조체      | TypeScript 생성 결과                  |

---

## 부록: 전체 예제

### 계산기 예제

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(a: i64, b: i64) -> i64 {
    a + b
}

#[command]
fn multiply(a: i64, b: i64) -> i64 {
    a * b
}

fn main() -> Result<()> {
    // 런타임 사용
    let pkg = rustra::build!("example.calculator", add_numbers, multiply)
        .done();

    let sum: i64 = pkg.invoke("addNumbers", serde_json::json!({ "a": 2, "b": 3 }))?;
    println!("2 + 3 = {sum}");

    // TypeScript 생성
    rustra::build!("example.calculator", add_numbers, multiply)
        .generate_to("generated")?;

    Ok(())
}
```

### 사용자 검색 예제

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
    pub display_name: String,
    pub email: String,
}

#[command]
fn find_user(input: UserQuery) -> Result<User> {
    Ok(User {
        id: "u-001".into(),
        display_name: input.name,
        email: format!("{}@example.com", input.name.to_lowercase()),
    })
}

fn main() -> Result<()> {
    let pkg = rustra::build!("app.users", find_user).done();

    let user: User = pkg.invoke(
        "findUser",
        UserQuery { name: "Alice".into(), age: Some(30) },
    )?;
    println!("Found: {} ({})", user.display_name, user.email);

    pkg.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

### 에러 처리 예제

```rust
use rustra::prelude::*;

#[bridge_type]
struct DivisionInput {
    pub dividend: i64,
    pub divisor: i64,
}

#[bridge_type]
struct DivisionOutput {
    pub quotient: i64,
    pub remainder: i64,
}

#[command]
fn divide(input: DivisionInput) -> Result<DivisionOutput> {
    if input.divisor == 0 {
        return Err(RustraError::custom(
            "division.by_zero",
            "cannot divide by zero",
        ));
    }
    Ok(DivisionOutput {
        quotient: input.dividend / input.divisor,
        remainder: input.dividend % input.divisor,
    })
}

fn main() -> Result<()> {
    let pkg = rustra::build!("math.division", divide).done();

    match pkg.invoke("divide", DivisionInput { dividend: 10, divisor: 3 }) {
        Ok(result) => println!("10 / 3 = {} (나머지: {})", result.quotient, result.remainder),
        Err(e) => eprintln!("[{}] {}", e.code(), e.message()),
    }

    Ok(())
}
```
