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

### 2-1. 구조체 파라미터 모드 (유일한 입력 형태)

`#[command]` 함수는 **정확히 하나의 Input 구조체 파라미터**를 받아야 합니다. 스칼라
멀티파라미터(`fn add(a: i64, b: i64)`)는 지원하지 않습니다 — 컴파일 에러가 납니다:

```text
#[command] supports at most one input data parameter
```

여러 값이 필요하면 Input 구조체를 정의합니다:

```rust
use rustra::prelude::*;

#[bridge_type]
struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    pub value: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}
```

`#[bridge_type]`은 `Serialize`/`Deserialize`/`JsonSchema` derive와
`#[serde(rename_all = "camelCase")]`를 자동 추가하므로 TypeScript 쪽에는
`{ a: number, b: number }`로 노출됩니다.

### 2-2. 0-파라미터 커맨드

입력이 필요 없는 명령은 `()` 입력으로 정의합니다:

```rust
#[command]
fn ping() -> Result<()> {
    Ok(())
}
```

`()` 입력은 TypeScript에서 파라미터 없는 함수로 생성됩니다
(`invoke('ping', undefined)`).

### 2-3. 반환 타입

반환은 **반드시 `Result<O>`** 여야 합니다. bare 반환(`-> i64`)과 unit 반환 생략은
컴파일 에러입니다:

```text
#[command] function must have an explicit return type Result<O>
```

```rust
// ✅ 올바른 반환
#[command]
fn divide(input: DivisionInput) -> Result<DivisionOutput> {
    if input.divisor == 0 {
        return Err(RustraError::invalid_args("division by zero"));
    }
    Ok(DivisionOutput {
        quotient: input.dividend / input.divisor,
        remainder: input.dividend % input.divisor,
    })
}
```

값이 없는 명령은 `Result<()>`를 사용합니다. 출력 `()`는 TypeScript에서
`Promise<void>`로 생성됩니다.

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
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    // 커맨드 이름이 "addNumbers" 대신 "calc.add" 로 등록된다
    Ok(AddNumbersOutput { value: input.a + input.b })
}
```

### 2-5. 컴파일 타임 검증

`#[command]` 매크로는 컴파일 타임에 다음을 검증합니다:

**파라미터 개수 검증** — 데이터 파라미터는 최대 1개입니다. 2개 이상이면 컴파일
에러가 발생합니다 (0개는 `()` 입력으로 허용 — §2-2 참고):

```text
#[command] supports at most one input data parameter
```

**trait bound 검증** — 입출력 타입이 필요한 trait을 충족하는지 확인합니다:

- 입력 타입: `DeserializeOwned + JsonSchema`
- 출력 타입: `Serialize + JsonSchema`

현재 trait bound가 충족되지 않으면 표준 Rust E0277 진단이 출력됩니다.
`#[diagnostic::on_unimplemented]` 기반 커스텀 메시지는 계획만 있고 구현되지 않았습니다 —
커스텀 에러 텍스트에 의존하지 마세요.

```text
error[E0277]: the trait bound `MyType: CommandInput` is not satisfied
   --> src/main.rs:5:1
    |
5   | #[command]
    | ^^^^^^^^^ the trait `CommandInput` is not implemented for `MyType`
    |
note: required for `MyType` to implement `CommandInput`
    (unsatisfied trait bound introduced by the blanket `impl<T> CommandInput for T`)
```

`CommandInput`/`CommandOutput`에 `#[diagnostic::on_unimplemented]`를 붙이면 이것이 더 친절한 메시지로 바뀝니다 (계획됨, 미구현):

```text
error: `MyType` cannot be used as a command parameter
   |
   = note: command parameters require Serialize + Deserialize + JsonSchema
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

`#[bridge_type]`은 항상 `#[serde(rename_all = "camelCase")]`를 추가합니다.
다른 명명 규칙이 필요하면 `#[bridge_type]` 없이 derive를 직접 붙입니다:

```rust
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
struct RawQuery {
    pub field_name: String, // JSON에서 "field_name"으로 유지
}
```

(`#[bridge(rename_all = "...")]` 형태의 오버라이드 속성은 존재하지 않습니다.)

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
// 등록 + 빌드
let pkg = rustra::build!("examples.calculator", add_numbers, multiply).done();

// TypeScript 생성은 Package 의 generate_typescript 에서
pkg.generate_typescript()?.write_schema_to_dir("generated")?;
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

`PackageBuilder`는 명령을 점진적으로 등록하는 빌더입니다. `Package::builder(id)`로 생성합니다 (또는 `rustra::build!` 매크로가 내부적으로 호출).

### `.command_fn(handler)`

`#[command]` 함수를 이름 자동 추론으로 등록합니다. 함수 이름에서 `_command` 접미사를
제거한 뒤 lowerCamelCase로 변환하여 커맨드 이름으로 사용합니다.

```rust
use rustra::register;

let pkg = register!(Package::builder("example.calculator"), add_numbers).build();
```

`register!` 매크로가 `#[command]` 함수를 `.command_fn()` 으로 연결해 줍니다.

### `.command(name, handler)`

이름을 직접 지정하여 등록합니다.

```rust
let pkg = Package::builder("example.calculator")
    .command("addNumbers", my_handler)
    .build();
```

같은 이름의 명령이 이미 등록되어 있으면 패닉이 발생합니다.

### `.buffer_command_fn(handler)` / `.buffer_command(name, handler)`

입력과 출력이 각각 하나의 필수 `Vec<u8>` 필드인 명령에 React Native의
`Uint8Array`/`ArrayBuffer` 전용 소유권 경로를 명시적으로 등록합니다. 일반
postcard/JSON 명령 계약도 함께 유지되므로 다른 호스트와 구 네이티브는 기존
경로로 동작합니다.

```rust
#[derive(Serialize, Deserialize, JsonSchema)]
struct Bytes {
    #[serde(with = "rustra::byte_buffer")]
    #[schemars(with = "Vec<u8>")]
    data: Vec<u8>,
}

impl BufferCommandInput for Bytes {
    fn from_buffer(data: Vec<u8>) -> Self { Self { data } }
}

impl BufferCommandOutput for Bytes {
    fn into_buffer(self) -> Vec<u8> { self.data }
}

#[command]
fn echo_bytes(input: Bytes) -> Result<Bytes> { Ok(input) }

let pkg = Package::builder("example.bytes")
    .buffer_command_fn(echo_bytes)
    .build();
```

스키마가 정확히 하나의 필수 `uint8` 배열 필드가 아니면 빌드 단계에서 패닉해
직접 ABI를 잘못 광고하지 않습니다. 입력 JS 메모리는 동기 호출 동안만 빌리고,
Rust 출력 allocation은 JSI `ArrayBuffer`가 수명 종료 시 해제합니다. 자세한
계약은 [direct byte-buffer 설계](plans/2026-08-24-rn-byte-buffer-native-path.md)를
참고합니다.

### 기타 빌더 메서드

| 메서드                                  | 역할                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `.require_capability(name, cap)`        | 명령에 capability 요구 부여 (deny-by-default Runtime Authority) |
| `.buffer_command_fn(handler)`           | 이름 추론 단일 `Vec<u8>` 직접 경로 등록                         |
| `.buffer_command(name, handler)`        | 명시 이름 단일 `Vec<u8>` 직접 경로 등록                         |
| `.alias_command_id(command, legacy_id)` | 구 cmd_id 별칭 등록 (하위호환 디스패치)                         |
| `.event_capacity(capacity)`             | 이벤트 버스 링 버퍼 용량 설정                                   |
| `.schema_version(version)`              | (T2, OTA) 스키마 협상 버전 명시                                 |
| `.manage(state)`                        | 공유 상태(`Package::state::<T>()`로 접근) 등록                  |

### `.build()` / `.done()`

등록된 모든 명령을 불변 `Package`로 빌드합니다. `.done()`은 `.build()`의 별칭입니다
(`rustra::build!` 확장 결과는 `.done()`으로 마무리).

```rust
let pkg = Package::builder("example.calculator")
    .command_fn(my_handler)
    .build();
```

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

### `.write_schema_to_dir(dir)`

계약 프로브 출력인 `schema.json`을 지정한 디렉토리에 저장합니다. 디렉토리가 없으면
생성합니다. 이어서 `rustra codegen`이 이 단일 파일에서 전 표면(types, commands,
contract, 코덱, 호스트 엔트리)을 렌더링합니다.

```rust
let generated = pkg.generate_typescript()?;
generated.write_schema_to_dir("generated")?;
```

파이프라인:

```text
generated/schema.json   # Rust 프로브가 발행
        │ rustra codegen --config rustra.json
        ▼
generated/
  schema.json      # 전체 명령 스키마
  types.ts         # TypeScript 타입 정의
  commands.ts      # TypeScript 명령 헬퍼 함수
  contract.ts      # GENERATED_CONTRACT_HASH 상수
  ...              # 코덱, positional facade, 호스트 엔트리
```

> Deprecated: `.write_to_dir(dir)`은 Rust에서 `types.ts`/`commands.ts`/`contract.ts`까지
> 썼습니다. 이 듀얼 패스가 단일 화살이 제거한 stale 파일 함정입니다. Node 없는 환경의
> 참고용 출력으로만 유지됩니다.

---

## 8. 에러 처리

### RustraError

모든 에러는 `code`와 `message` 필드를 가집니다.

```rust
use rustra::prelude::*;

#[bridge_type]
struct DivideInput { a: i64, b: i64 }

#[bridge_type]
struct DivideOutput { value: i64 }

#[command]
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("division.by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
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
JS 측 `invoke`의 `options.timeoutMs`는 만료 시 이 `transport.timeout`(retryable)로
거부한다 — 네이티브 hang의 JS 측 탈출구.

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

### 사용자 정의 제네릭 타입

`Wrapper<T> { value: T }` 같은 제네릭 구조체는 **구체 인스턴스 단위로** 동작합니다.
schemars 0.8은 인스턴스마다 모노몰포이즈된 스키마를 만들고(`Wrapper<String>` →
스키마 이름 `Wrapper_for_String`), rustra는 명령의 `inputType`/`outputType`을 그
schemars 이름에 고정합니다. 결과물은 유효한 TypeScript 식별자이며 스키마 `title`과
`definitions` 키와 일치하므로 검증·TS/C++ 렌더링·코덱 생성이 특수 처리 없이 하나의
이름으로 묶입니다.

```rust
#[bridge_type]
struct Wrapper<T> { value: T }

#[command]
fn echo_wrapped(input: Wrapper<String>) -> Result<Wrapper<String>> {
    Ok(Wrapper { value: input.value })
}
```

```typescript
export type Wrapper_for_String = { value: string };
```

참고:

- `Option<T>`, `Vec<T>`, `Result<T, E>`(명령 반환), `Box<T>`는 표준 라이브러리
  제네릭으로 별도 처리가 필요 없습니다 — 위 표를 참고하세요.
- 파라미터화된 제네릭 템플릿(`Wrapper<T>` 자체)은 코드젠되지 않습니다. 사용된
  인스턴스마다 각각의 타입이 생성됩니다. 구체 별칭(`type StringWrapper =
Wrapper<String>;`)도 하나의 구체 타입으로 동작합니다.
- 구버전 rustra는 `type_name`이 그대로 `inputType`에 새어 나갔습니다
  (`Wrapper<String >` — 식별자 아님). 오래된 schema.json이 CLI 검증에서
  "generic type name" 오류로 실패하면, 현재 rustra로 Rust 패키지를 재빌드하고
  `schema.json`을 재생성하세요.

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

반환값이 원시 타입(`i64`, `String`, `bool`)이면 코드젠은 inline하지 않고, 이름 붙은 별칭을 `types.ts`에 발행해 커맨드 출력 타입으로 사용합니다(`int64`는 `number | bigint`로 widen, `String`/`Boolean`은 `string`/`boolean`의 rename). 입력도 마찬가지로 단일 구조체 + `Result<O>` 계약을 지킵니다:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<i64> { Ok(input.a + input.b) }
```

<!-- prettier-ignore -->
```typescript
// 스칼라 출력은 넓혀진 원시 타입 별칭(i64 → number | bigint)을 유지한다.
// 스칼라 반환 커맨드의 실제 코드젠 산출물과 동일한 형태다.
export type int64 = number | bigint;

export const addNumbers = createGeneratedFields2<AddNumbersInput, int64>(1, 'addNumbers', "a", "b", 'addNumbers');
```

### 생성된 types.ts 예시

```typescript
export type { EngineClient, RustraError } from '@rustra/types';
export { RustraCommandError } from '@rustra/types';

export type AddNumbersInput = {
  a: number | bigint;
  b: number | bigint;
};

export type AddNumbersOutput = {
  value: number | bigint;
};
```

### 생성된 commands.ts 예시

<!-- docs:sync:begin examples/calculator/generated/commands.ts -->

<!-- prettier-ignore -->
```typescript
import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, MultiplyInput, MultiplyOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedBytes, invokeGeneratedFields1, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions } from '@rustra/types';

export const addNumbers = createGeneratedFields2<AddNumbersInput, AddNumbersOutput>(1, 'addNumbers', "a", "b", 'addNumbers');

export const benchAdd = createGeneratedFields2<BenchAddInput, BenchAddOutput>(23, 'benchAdd', "a", "b", 'benchAdd');

export function benchEchoBytes(input: BenchBytesPayload, options?: InvokeOptions): Promise<BenchBytesPayload> {
  return invokeGeneratedBytes<BenchBytesPayload>(25, 'benchEchoBytes', input, input["data"], options);
}
benchEchoBytes.commandId = 'benchEchoBytes';

export const benchEchoPair = createGeneratedFields2<BenchPairPayload, BenchPairPayload>(26, 'benchEchoPair', "name", "value", 'benchEchoPair');

export function benchEchoString(input: BenchStringPayload, options?: InvokeOptions): Promise<BenchStringPayload> {
  return invokeGeneratedFields1<BenchStringPayload>(24, 'benchEchoString', input, input["value"], options);
}
benchEchoString.commandId = 'benchEchoString';

export const channelDemo = createGeneratedFields2<ChannelDemoInput, ChannelDemoOutput>(18, 'channelDemo', "channel", "ticks", 'channelDemo');

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(8, 'createItem', "name", "value", 'createItem');

export const divide = createGeneratedFields2<DivideInput, DivideOutput>(10, 'divide', "a", "b", 'divide');

export function echoGroups(input: EchoGroupsInput, options?: InvokeOptions): Promise<EchoGroupsOutput> {
  return invokeGenerated<EchoGroupsOutput>(27, 'echoGroups', input, options);
}
echoGroups.commandId = 'echoGroups';

export const emitDemo = createGeneratedFields2<EmitDemoInput, EmitDemoOutput>(11, 'emitDemo', "ticks", "stepDelayMs", 'emitDemo');

/**
 * u64/u32 필드 — plain varint(uvar) 와이어 고정(과거 zigzag 버그 수정 증명).
 */
export const gauge = createGeneratedFields2<GaugeInput, GaugeOutput>(17, 'gauge', "limit", "offset", 'gauge');

export function greet(input: GreetInput, options?: InvokeOptions): Promise<GreetOutput> {
  return invokeGeneratedFields1<GreetOutput>(5, 'greet', input, input["name"], options);
}
greet.commandId = 'greet';

export function isEven(input: IsEvenInput, options?: InvokeOptions): Promise<IsEvenOutput> {
  return invokeGeneratedFields1<IsEvenOutput>(3, 'isEven', input, input["n"], options);
}
isEven.commandId = 'isEven';

export const multiply = createGeneratedFields2<MultiplyInput, MultiplyOutput>(2, 'multiply', "a", "b", 'multiply');

export function processItem(input: ProcessItemInput, options?: InvokeOptions): Promise<ProcessItemOutput> {
  return invokeGenerated<ProcessItemOutput>(9, 'processItem', input, options);
}
processItem.commandId = 'processItem';

export function resourceClose(input: ResourceCloseInput, options?: InvokeOptions): Promise<ResourceCloseOutput> {
  return invokeGeneratedFields1<ResourceCloseOutput>(22, 'resourceClose', input, input["handle"], options);
}
resourceClose.commandId = 'resourceClose';

export function resourceOpen(input: ResourceOpenInput, options?: InvokeOptions): Promise<ResourceHandleOutput> {
  return invokeGenerated<ResourceHandleOutput>(19, 'resourceOpen', input, options);
}
resourceOpen.commandId = 'resourceOpen';

export const resourceRead = createGeneratedFields2<ResourceReadInput, ResourceReadOutput>(20, 'resourceRead', "handle", "key", 'resourceRead');

export function resourceWrite(input: ResourceWriteInput, options?: InvokeOptions): Promise<ResourceWriteOutput> {
  return invokeGeneratedFields3<ResourceWriteOutput>(21, 'resourceWrite', input, input["handle"], input["key"], input["value"], options);
}
resourceWrite.commandId = 'resourceWrite';

/**
 * 런타임 registry 제어 명령. op:
 * `register` / `unregister` / `replacePing` / `replaceAdd` / `restoreAdd` / `freeze` / `state`.
 */
export function rustraRegistryDemo(input: RegistryDemoInput, options?: InvokeOptions): Promise<RegistryDemoOutput> {
  return invokeGeneratedFields1<RegistryDemoOutput>(12, 'rustraRegistryDemo', input, input["op"], options);
}
rustraRegistryDemo.commandId = 'rustraRegistryDemo';

/**
 * HashMap<String, i64>(동적 맵) — count + (key,value)* 와이어 고정.
 */
export function scoreTotal(input: ScoreTotalInput, options?: InvokeOptions): Promise<ScoreTotalOutput> {
  return invokeGenerated<ScoreTotalOutput>(15, 'scoreTotal', input, options);
}
scoreTotal.commandId = 'scoreTotal';

export const secureCompute = createGeneratedFields2<SecureComputeInput, SecureComputeOutput>(13, 'secureCompute', "a", "b", 'secureCompute');

/**
 * Vec<u8>(postcard bytes) 입력 + u32 출력 — plain varint 와이어 고정.
 */
export function sizeOf(input: SizeOfInput, options?: InvokeOptions): Promise<SizeOfOutput> {
  return invokeGeneratedBytes<SizeOfOutput>(14, 'sizeOf', input, input["data"], options);
}
sizeOf.commandId = 'sizeOf';

/**
 * (String, i64) 튜플 — i64 때문에 complex-binary count + elements 와이어.
 */
export function span(input: SpanInput, options?: InvokeOptions): Promise<SpanOutput> {
  return invokeGenerated<SpanOutput>(16, 'span', input, options);
}
span.commandId = 'span';

export function sumList(input: SumListInput, options?: InvokeOptions): Promise<SumListOutput> {
  return invokeGenerated<SumListOutput>(6, 'sumList', input, options);
}
sumList.commandId = 'sumList';

export function tagSet(input: TagSetInput, options?: InvokeOptions): Promise<TagSetOutput> {
  return invokeGenerated<TagSetOutput>(29, 'tagSet', input, options);
}
tagSet.commandId = 'tagSet';

export function toUpper(input: ToUpperInput, options?: InvokeOptions): Promise<ToUpperOutput> {
  return invokeGeneratedFields1<ToUpperOutput>(7, 'toUpper', input, input["s"], options);
}
toUpper.commandId = 'toUpper';

/**
 * A2 와이드 정수 복합 타입 표본 — Vec<u64> + Option<i64>. 원소/옵션 레벨 uvar64/zigzag64 헬퍼가 스트림 중간 7바이트 varint 경계를 넘는 값을 무손실 왕복하는지 cross-wire 픽스처로 고정한다.
 */
export function wideAgg(input: WideAggInput, options?: InvokeOptions): Promise<WideAggOutput> {
  return invokeGenerated<WideAggOutput>(28, 'wideAgg', input, options);
}
wideAgg.commandId = 'wideAgg';
```

<!-- docs:sync:end -->

(`invokeGenerated`는 생성된 호스트 진입점이 `configureLazy()`로 등록한 엔진을 사용한다 —
호스트 어댑터 import가 앞선다면 호출부에서 엔진을 직접 구성할 필요가 없다)

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

### 고급 API 요약 (문서 본문에서 다루지 않은 공개 API)

**이벤트 버스** — Rust → JS 이벤트 푸시:

```rust
// 이벤트 발행 (드랍 가능 — 링 버퍼)
pkg.emit("item.created", serde_json::json!({ "id": "x1" }));

// 네이티브 싱크 연결 (RN JSI 드레인 등)
pkg.set_event_sink(Some(sink));
let bus = pkg.event_bus(); // EventBus 직접 접근
```

**Runtime Authority (capability)** — deny-by-default 권한:

```rust
// 빌더에서 요구 지정
Package::builder("app.secure")
    .command("secureCompute", handler)
    .require_capability("secureCompute", "app.admin")
    .build();

// 런타임 부여 — 부여 전까지 capability.denied
pkg.grant_capability("app.admin")?;
```

**FFI (C ABI)** — 네이티브 모듈/프로세스 경유 호출 (`rustra::ffi`):

- `rustra_ffi_register` / `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard`
- `rustra_ffi_invoke_async` / `rustra_ffi_invoke_cancel` — 체크포인트 취소 전파
- `rustra_ffi_set_max_payload` / `rustra_ffi_contract_hash` / `rustra_ffi_schema_json`

**동결(freeze)** — 런타임 mutation 잠금:

```rust
pkg.freeze();          // 이후 register/unregister 는 registry.frozen 에러
assert!(pkg.is_frozen());
```

**Tauri 지원** (`tauri` feature) — `rustra::tauri_support`:

- `tauri_support::register(app, pkg)` — invoke 핸들러 등록
- `tauri_support::register_with_events(...)` — 이벤트 푸시 포함
- `tauri_support::rustra_dispatch(...)` — 커맨드 디스패치

**스키마/버전** — `pkg.schema()` (전체 스키마 JSON), `pkg.live_schema()`
(동적 명령 포함), `.schema_version(v)` 빌더 (T2/OTA 협상).

### 계산기 예제

```rust
use rustra::prelude::*;

#[bridge_type]
struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    pub value: i64,
}

#[bridge_type]
struct MultiplyInput {
    pub a: f64,
    pub b: f64,
}

#[bridge_type]
struct MultiplyOutput {
    pub value: f64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

#[command]
fn multiply(input: MultiplyInput) -> Result<MultiplyOutput> {
    Ok(MultiplyOutput {
        value: input.a * input.b,
    })
}

fn main() -> Result<()> {
    // 런타임 사용
    let pkg = rustra::build!("example.calculator", add_numbers, multiply).done();

    let sum: AddNumbersOutput = pkg.invoke("addNumbers", AddNumbersInput { a: 2, b: 3 })?;
    println!("2 + 3 = {}", sum.value);

    // TypeScript 생성
    pkg.generate_typescript()?.write_schema_to_dir("generated")?;

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

    pkg.generate_typescript()?.write_schema_to_dir("generated")?;
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

---

## 부록: bootstrap 인스턴스 소유권 (단일 엔진 슬롯)

각 JS 호스트 프로세스는 **하나의 글로벌 엔진 슬롯**을 가진다. 생성된 호스트
진입점이 `configureLazy()`로 bootstrap 을 등록하고(또는 `configure()`로 명시적
엔진을 등록하고), 모든 invoke 는 그 단일 슬롯으로 라우팅된다.

현재 정책(R08 — 조기 가드):

- **첫 등록이 승리한다.** 첫 bootstrap 이 아직 소비되지 않은 상태(등록 후 첫
  `ready()`/invoke 가 시작되기 전)에서 두 번째 bootstrap 을 등록하면
  `registry.frozen` 을 throw 한다 — import 순서가 조용히 엔진을 정하는 일은
  이제 없다.
- **소비 뒤의 재등록은 그대로 허용된다.** `dispose()` + 같은 bootstrap 클로저
  (Node/Bun 어댑터의 `reload()`) 재등록은 자유롭고, 소비가 시작된 뒤의 lazy
  교체와 초기화 실패 뒤의 복구 등록은 기존 계약을 따른다.
- **다중 엔진은 미지원이다.** 이 가드는 사고로 인한 교차 호스트 등록을 조기에
  실패시키기 위한 것(`configure`/`configureLazy` 의 `ownerId` 가 에러 메시지에
  양쪽 주체를 보고한다)이며, 다중 엔진 API 가 아니다.

모든 자사 어댑터(`createNodeBootstrap`, `createBunBootstrap`,
`createTauriBootstrap`, RN `createRustraBootstrap`)가 같은 슬롯 경로를
공유하므로 가드가 자동으로 함께 적용된다.
