[English](./rust-api-guide.md)

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

현재 trait bound가 충족되지 않으면 표준 Rust E0277 진단이 출력됩니다:

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

로드맵: `CommandInput`/`CommandOutput`에 `#[diagnostic::on_unimplemented]`를 붙여
더 친절한 메시지(예: `#[bridge_type]` 제안)로 바꿀 계획이 있으나 미구현이다 —
위의 E0277 텍스트를 기준으로 읽는다.

---

### 2-6. 비동기 커맨드와 실행기

`#[command]`는 `async fn`을 받습니다. 비동기 커맨드도 동기 커맨드와 똑같이 등록·스키마
생성·디스패치됩니다:

```rust
#[command]
async fn find_user(input: UserQuery) -> Result<User> {
    let user = slow_lookup(&input.id).await;
    Ok(user)
}
```

async 문법 지원은 범용 비동기 런타임 제공이 **아닙니다**. 생성된 래퍼는 호출 스레드에서
park 기반 실행기로 future를 구동합니다(waker는 `Thread::unpark`;
`crates/rustra/src/executor.rs` 참고). 호스트 통합자가 알아야 할 귀결은 네 가지입니다:

1. **실행기는 현재 스레드를 park 합니다.** 멀티스레드 호스트 런타임(예: tokio) 안에서
   park된 워커 스레드는 굶은 워커입니다 — 비동기 커맨드 디스패치를 `spawn_blocking`
   (또는 동등한 전용 풀)으로 돌리거나, 완전한 비동기 dispatch 경로를 기다리세요. FFI
   async 경로에서는 핸들러가 rustra 고정 워커 풀(아래)에서 실행되므로 느린 비동기
   커맨드 하나가 워커 2개 중 하나를 점유합니다.
2. **`State<T>`는 thread-local이라 spawned task에서 보이지 않습니다.** 상태 주입은
   thread-local 컨텍스트로 전달되어 디스패치가 시작된 스레드에서만 유효합니다. 핸들러가
   다른 워커로 옮긴 태스크에서 `State` 조회는 `None`입니다. spawn 전에 필요한 값을
   미리 캡처하세요(`Arc` 클론).
3. **FFI async 호출은 고정 풀 — 워커 2개, 큐 깊이 256 — 에서 실행됩니다.** 풀은
   fail-fast입니다. 큐가 가득 차면 hang하지 않고 즉시 `invoke.backpressure`로
   거부합니다(`crates/rustra/src/ffi_pool.rs`). 백프레셔로 다뤄 drain 후 재시도하세요.
   상수는 고정값이며 설정할 수 없습니다.
4. **I/O 리액터나 타이머 드라이버는 제공하지 않습니다.** 런타임 컨텍스트와 무관하게
   완료되는 future라면 무엇이든 동작합니다 — 어떤 스레드에서 깨워도 park된 스레드가
   unpark 됩니다. 리액터나 타이머를 요구하는 future(tokio 리소스, `tokio::time`)는
   디스패치 주위에 호스트의 런타임 진입이 필요합니다. rustra는 만들어주지 않습니다.

실행기 주입(자체 `block_on` 끼워 넣기)은 지원하지 않습니다. 필요성을 느낀다면 먼저
측정하세요 — 의도적으로 범위 밖입니다.

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

계약 요지(사용자가 의존하는 부분):

- **스키마 조건** — 명령의 입력과 출력이 각각 정확히 하나의 필수 `uint8`
  배열(`Vec<u8>`) 필드여야 한다. 아니면 `build()` 단계에서 패닉해 직접 ABI를
  잘못 광고하지 않는다.
- **메모리 소유** — 입력 JS 메모리는 동기 호출 동안만 빌리고, Rust 출력
  allocation은 JS 소유 `ArrayBuffer`로 복사된 뒤 JSI `ArrayBuffer`가 수명 종료
  시 해제한다(JS 쪽 수동 포인터 관리는 없다).
- 일반 postcard/JSON 명령 계약도 함께 유지되므로 다른 호스트와 구 네이티브는
  기존 경로로 동작한다.

설계 근거와 C++/JSI 경계 전체 논의:
[direct byte-buffer 설계](plans/2026-08-24-rn-byte-buffer-native-path.md).

### 기타 빌더 메서드

| 메서드                                  | 역할                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.require_capability(name, cap)`        | 명령에 capability 요구 부여 (deny-by-default Runtime Authority)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.platform_command::<I, O>(name, ps)`   | 플랫폼 특화 명령 선언 — **전 플랫폼**에 등록 (미지원은 스텁)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `.platform_command_impl(name, handler)` | 지원 플랫폼에서 실제 핸들러 주입                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.buffer_command_fn(handler)`           | 이름 추론 단일 `Vec<u8>` 직접 경로 등록                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `.buffer_command(name, handler)`        | 명시 이름 단일 `Vec<u8>` 직접 경로 등록                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `.alias_command_id(command, legacy_id)` | 구 cmd_id 별칭 등록 (하위호환 디스패치)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `.event::<T>(name)`                     | 이벤트 계약 선언 — `name`의 페이로드 타입 `T`. schema.json `events`에 기록되고 `generated/events.ts`로 렌더링 ([이벤트·채널 가이드](events-and-channels.ko.md) 참고)                                                                                                                                                                                                                                                                                                |
| `.event_capacity(capacity)`             | 이벤트 버스 링 버퍼 용량 설정                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.schema_version(version)`              | (T2, OTA) 스키마 협상 버전 명시                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.manage(state)`                        | 공유 상태 등록 (`State<T>` 파라미터와 `Package::state::<T>()`로 접근)                                                                                                                                                                                                                                                                                                                                                                                               |
| `.command_errors(name, variants)`       | 커맨드의 도메인 에러 코드 선언 (`&[CommandErrorVariant]`; `#[command(error(...))]`의 빌더 형태) — schema.json `errors`에 기록되고 `generated/errors.ts`로 렌더된다(아래 "커맨드별 에러 코드 선언" 절 참고)                                                                                                                                                                                                                                                          |
| `.command_devices(name, devices)`       | 커맨드가 전제하는 디바이스 역량 선언 (`&[DeviceCapability]`; `#[command(device(camera, bluetooth))]`의 빌더 형태) — schema.json `devices`와 최상위 `deviceCapabilities` 카탈로그에 기록되고 `generated/devices.ts`로 렌더된다; 런타임 게이팅은 없다. 미등록 커맨드·빈 목록·중복 토큰, 그리고 **release 빌드 한정** 카탈로그 밖 토큰에 패닉한다(debug 빌드는 경고 후 수용; [dev-tier.ko.md](dev-tier.ko.md)와 [플랫폼 권한 가이드](platform-permissions.ko.md) 참고) |

### 상태 주입: `State<T>` 파라미터

`#[command]` 함수는 단일 입력 구조체 외에 추가 `State<T>` 파라미터를 받을 수 있다.
상태는 빌더의 `.manage(state)`로 등록하고, 매크로가 `rustra::get_state::<T>()`로
핸들러에 주입한다. `.manage()` 없이 등록된 `State<T>` 파라미터를 가진 명령을 호출하면
`internal` 에러 `State<T> not managed in package`로 실패한다.

```rust
use rustra::prelude::*;

#[bridge_type]
struct QueryInput { user_id: String }

#[bridge_type]
struct QueryOutput { display_name: String }

struct Db { /* 커넥션 풀, 캐시 등 */ }

#[command]
fn query_user(input: QueryInput, db: State<Db>) -> Result<QueryOutput> {
    let _db: &Db = &db.0; // State<T>(pub Arc<T>) — 저렴한 공유 핸들
    Ok(QueryOutput { display_name: input.user_id })
}
```

```rust
let pkg = Package::builder("app.users")
    .command_fn(query_user)
    .manage(Db { /* ... */ })
    .build();
```

`State<T>` 파라미터는 와이어 계약에 포함되지 않는다 — schema.json에 나타나지
않으므로 추가/제거가 breaking change가 아니다.

### 플랫폼 특화 명령 (`.platform_command` / `.platform_command_impl`)

Win32/AppKit 호출, 네이티브 윈도우 핸들 같은 플랫폼 특화 명령도 계약은 플랫폼
무관하게 안정적이다. `platform_command` 는 command_id·schema.json·계약 해시를
**전 플랫폼에서 동일하게** 등록하고 미지원 플랫폼에는 `platform.unavailable`
을 반환하는 스텁을 심는다. `platform_command_impl` 이 지원 플랫폼에서 스텁을
실제 핸들러로 교체한다:

```rust
use rustra::platform::Platform;

let builder = Package::builder("app.native")
    .platform_command::<(), NativeWindowInfo>(
        "nativeWindowInfo",
        &[Platform::Windows, Platform::Macos],
    );
// 실구현은 존재하는 플랫폼에서만 컴파일되도록 cfg 로 보호한다.
#[cfg(any(target_os = "windows", target_os = "macos"))]
let builder = builder.platform_command_impl("nativeWindowInfo", native_window_info_impl);
let pkg = builder.build();
```

계약:

- 명령 집합(id·스키마·해시)은 전 플랫폼에서 동일 — by-id 디스패치와 교차
  검증이 플랫폼 때문에 밀리지 않는다.
- 미지원 플랫폼에서 스텁 호출은 `platform.unavailable`(non-retryable) —
  "계약 자체에 없는" `command.not_found` 와 구분된다.
- 현재 플랫폼이 선언 목록에 있는데 `platform_command_impl` 을 빠뜨리면
  `build()` 가 패닉한다(지원 플랫폼에서 조용한 스텁 방치는 배선 결함).
  반대로 선언되지 않은 플랫폼에서 `platform_command_impl` 을 호출하면 그
  자리에서 패닉한다(`#[cfg]` 배치 오류).
- 선언과 구현의 `I`/`O` 타입은 동일해야 한다 — 플랫폼별로 스키마가 달라지면
  안 된다.
- schema.json 에는 이런 명령에 `"platforms": [...]` 가 기록된다 — 지원
  플랫폼이 아닌 호출자는 호출 전에 분기할 수 있다.

불투명 네이티브 리소스(Win32 `HANDLE`, `NSView*`, …)는 기존 `ResourceHandle`
패턴을 따른다 — 실체는 Rust 측 리소스 테이블(channels 모듈의
`ResourceHandle`)에 두고 JS 는 `u32` id 만 주고받는다. 64비트 포인터를 JS 에
직접 노출하지 않는다.

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

타입 안전한 명령 호출입니다 — JSON 경로를 왕복하는 편의 래퍼입니다
(`serde_json` → `invoke_json` → `serde_json`).

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

### `.invoke_typed::<I, O>(name, &input)`

Frame(postcard) 와이어 경로를 타는 타입 호출입니다 — TS 코덱이 쓰는 것과 같은
단일 dispatch 경로입니다. 명령을 이름으로 조회하고(`invoke_json` 과 동일한
frozen/mutable 이중 경로), Frame 요청 `[id: u16 LE @0][postcard(I) @2]` 을
조립해 `invoke_frame` 으로 dispatch 하고 응답 프레임을 디코딩합니다 — 실행
경로를 이원화하지 않으면서 Rust↔TS 바이너리 계약을 실제로 통과시킵니다.
핸들러 에러는 `code`/`message` 가 그대로 보존됩니다(에러 프레임 인코딩은 FFI
경계의 책임). postcard 가 직렬화하지 못하는 입력(Tier 3, JSON 전용)의 명령은
typed 호출 대상이 아닙니다.

```rust
let output: AddNumbersOutput =
    pkg.invoke_typed("addNumbers", &AddNumbersInput { a: 2, b: 3 })?;
```

### Frame 와이어 헬퍼 (크레이트 레벨 자유 함수)

raw Frame 응답/에러 프레임을 다루는 모든 곳의 동반 헬퍼입니다
(`crates/rustra/src/frame_error.rs`). 성공 프레임은
`[ok:1][7B reserved][postcard(O) @8]`, 에러 프레임은
`[ok: u8 @0 = 0][pad 7B][err_len: u16 @8 LE][postcard({code, message}) @10...]` 입니다.

- `decode_frame_response(frame: &[u8]) -> Result<&[u8]>` — 성공 프레임의 postcard
  본문을 빌려 반환합니다. 에러 프레임은 `code` 와 `message` 가 합쳐진
  (`"{code}: {message}"`) `RustraError::internal` 로 돌아옵니다. 코드를 따로
  필요하면 아래 구조화 변형을 쓰세요.
- `decode_frame_error_parts(frame: &[u8]) -> Result<(String, String)>` — 에러
  프레임 한정 구조화 변형: 소유 `(code, message)` 쌍을 반환합니다. 성공 프레임은
  `command.invalid_args` 로 거절합니다.
- `encode_frame_error(error: &RustraError) -> Vec<u8>` — 에러를 FFI 경계용 와이어
  에러 프레임으로 인코딩합니다(postcard `{code, message}`, 메시지가 `u16::MAX` 를
  넘으면 잘림 마커를 남깁니다).

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

> `.write_schema_to_dir(dir)`은 `schema.json`만 발행합니다. TS 표면(`types.ts` 등)은
> `rustra codegen`의 소관 — Rust에서 재생성하지 않습니다. 구(舊) `.write_to_dir(dir)`
> 듀얼 패스는 이런 이유로 deprecated입니다.

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

#[command(error("math.divide_by_zero"))]
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("math.divide_by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
}
```

### 커맨드별 에러 코드 선언 (타입화 에러)

TypeScript 에서 `err.code` 를 문자열 비교로 분기하면 코드 오타가 컴파일 타임에
잡히지 않는다. 커맨드가 반환할 수 있는 도메인 코드를 선언하면 `rustra codegen`이
커맨드별 리터럴 유니언 + 타입 가드로 바꿔준다.

속성 폼으로 선언한다(권장 — 선언이 핸들러 옆에 산다):

```rust
#[command(error("math.divide_by_zero"))]
fn divide(input: DivideInput) -> Result<DivideOutput> { /* … */ }
```

빌더 체인으로도 가능하며, 메타데이터(생성 JSDoc/`retryable` — 문서 메타데이터로만
소비되고 와이어 의미는 바꾸지 않는다)를 붙일 수 있다:

```rust
use rustra::CommandErrorVariant;

let package = Package::builder("example.math")
    .command_errors(
        "divide",
        &[CommandErrorVariant::new("math.divide_by_zero")
            .describe("나누는 수가 0일 때")],
    )
    // …명령 등록 후 build…
```

`rustra codegen`을 다시 돌리면, 에러를 선언한 커맨드가 1건이라도 있을 때 생성
`errors.ts`가 나타난다. TypeScript 측에서는 문자열 비교 대신 가드로 좁힌다:

```ts
import { isDivideError, DivideErrorCode } from './generated/errors.js';

try {
  await divide({ a: 10, b: 0 });
} catch (e) {
  if (isDivideError(e) && e.code === DivideErrorCode.MathDivideByZero) {
    // 여기서 e 는 DivideError — e.code === 'math.divideBy_zero' 는 컴파일 에러.
  }
}
```

규칙:

- 코드는 `^[a-z][a-z0-9_.]*$` 를 만족해야 한다 — 위반 시 빌더가 패닉한다(JSON
  폴백 경로가 이런 코드를 Display 출력에서 되분할할 수 없기 때문).
- 선언은 커맨드의 **도메인** 코드만 담는다. 프레임워크 코드(`cancelled`,
  `transport.timeout`, `command.invalid_args`, …)는 어느 커맨드에서든 발생할 수
  있어 공유 `RustraErrorCode` 표에 그대로 둔다 — 그쪽은 직접 비교한다.
- 선언은 계약 문서이지 런타임 검증이 아니다. 핸들러가 미선언 코드를 반환해도
  그대로 흐르고, 가드는 그런 코드에 false 를 반환한다(런타임은 개방 계약, 타입은
  폐쇄 유니언). 선언 추가는 schema.json 과 계약 해시를 바꾼다 — 의도된 계약
  진화이며 `rustra diff` 가 잡는다.
- 와이어 에러 프레임과 `RustraCommandError`는 무변경 —
  [wire-format.md](./wire-format.md) 참조.

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

### JS 호출 시맨틱: signal, timeoutMs, invokeBatch

생성된 모든 헬퍼는 마지막 파라미터로 `InvokeOptions`를 받고, `@rustra/types`는
raw `invoke`/`invokeBatch`에도 같은 옵션을 제공한다:

```ts
import { invokeBatch } from '@rustra/types';
import { addNumbers, slowCompute } from './generated/commands.js';

// 취소 — AbortSignal은 프라미스를 즉시 거부한다(`cancelled`).
// invokeCancel 전파가 없는 호스트에서는 얕은 취소다.
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
await addNumbers({ a: 20, b: 22 }, { signal: controller.signal });

// 타임아웃 — deadline 후 `transport.timeout`(retryable)으로 거부
await slowCompute({ workload: 'heavy' }, { timeoutMs: 500 });

// 배치 — 하나의 배열, 순서 보존; signal 없는 항목은 Frame 엔진에서
// 단일 native crossing으로 묶일 수 있다
const [sum, echo] = await invokeBatch([
  { command: 'addNumbers', args: { a: 20, b: 22 } },
  { command: 'echo', args: { message: 'hi' }, options: { timeoutMs: 1000 } },
]);
```

옵션별 어댑터 동작(어느 취소가 얕은지, 어느 배치가 단일 횡단인지)은
[호환성 매트릭스](compatibility-matrix.ko.md)에 있다.

### 타임아웃·취소·재시도 의미 (플래그가 뜻하는 것과 뜻하지 않는 것)

`retryable: true`는 transport가 *재시도 가능 부류의 실패*를 관측했다는 뜻이지,
명령이 재실행해도 안전하다는 뜻이 **아니다**.

**응답을 받지 못함 ≠ 명령이 실행되지 않음.** 얕은 취소(`invokeCancel`이 없는 어댑터의
`options.signal`)와 `options.timeoutMs`는 모두 JS 프라미스를 버릴 뿐, Rust 측은 계속
간다. 둘 중 하나가 발화한 뒤에도 명령은 실행 중일 수 있고 — 이미 완료해 결과가
버려졌을 수도 있다. retryable 플래그만 보고 비멱등 명령을 재실행하면 이중 청구,
이중 발송, 이중 insert가 생긴다. 일반 transport 실패에서 재시도하기 전에 효과부터
확인하라:

```ts
import { withRetry } from '@rustra/types';

// 안전: 읽기 커맨드 — 재시도해도 부작용이 중복되지 않는다.
const user = await withRetry((attempt) => invoke('getUser', { id }), {
  retries: 2,
  baseDelayMs: 100,
});

// 가드 없이는 안전하지 않다: 비멱등 명령을 무조건 재시도하지 마라.
// retryIf 로 재시도 판정을 좁혀라 — 기본 판정(isRetryableCode:
// transport.error / transport.timeout / cancelled)을 완전히 대체한다:
await withRetry((attempt) => invoke('chargeCard', { id, amountCents: 500 }), {
  retryIf: (err) => err.code === 'transport.error', // 연결 수준 실패만
});
// 성공 여부를 관측할 수 없는 쓰기라면 추측하지 말고 대조하라:
//   상태 재조회로 쓰기가 자리 잡지 않았음이 확인된 뒤에만 재시도한다.
```

배치 reject는 rollback이 아니다. `invokeBatch`는 항목이 실패하면 전체 프라미스를
거부하지만, 디스패치된 항목은 실행됐고 그 효과는 남는다 — all-or-nothing
트랜잭션이 없다. 항목별 폴백은 모든 항목을 동시에 시작하고, RN 단일 횡단 배치는
첫 실패 항목에서 멈추며, Tauri wire 배치는 전부 실행한 뒤 거부한다. `invokeBatch`
자체에 settled 형태는 없다 — 부분 결과를 관측하려면 `invokeBatchSettled`
(`@rustra/types`)를 쓰라: 항상 per-entry 순차 실행(원자적 와이어 배치는 사용하지
않음)이라 실패한 항목과 그 이후 항목이 구별된다 — 항목별로
`{ status: 'fulfilled', value }`, `{ status: 'rejected', reason }`,
`{ status: 'unexecuted' }` 중 하나로 settle 되며, `unexecuted`는 dispatch 자체가
일어나지 않았음을 뜻한다. 항목별 `signal`/`timeoutMs`는 단건 `invoke`와 동일하게
적용된다.

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

| Rust 타입                    | TypeScript 타입                                    |
| ---------------------------- | -------------------------------------------------- |
| `i64`, `u64`                 | `number \| bigint` (±2^53 밖 값은 `bigint`로 복원) |
| `i32`, `u32`, `f64` 등       | `number`                                           |
| `String`                     | `string`                                           |
| `bool`                       | `boolean`                                          |
| `Option<T>`                  | `T \| null` (구조체 필드는 `?:` 선택적)            |
| `Vec<T>`                     | `T[]`                                              |
| `Vec<Vec<T>>`                | `T[][]` (중첩 지원)                                |
| `HashMap<String, V>`         | `Record<string, V>`                                |
| `BTreeSet<T>` / `HashSet<T>` | `Set<T>` (`uniqueItems` 매핑)                      |
| `(A, B, C)`                  | `[A, B, C]` (튜플)                                 |
| 단순 `enum`                  | `'Variant1' \| 'Variant2'`                         |
| 데이터를 가진 `enum`         | 객체 유니온 타입                                   |

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
import type { AddNumbersInput, AddNumbersOutput, BenchAddInput, BenchAddOutput, BenchBytesPayload, BenchPairPayload, BenchStringPayload, ChannelDemoBytesInput, ChannelDemoBytesOutput, ChannelDemoInput, ChannelDemoOutput, ClampInput, ClampOutput, CreateItemInput, CreateItemOutput, DeviceDemoOutput, DivideInput, DivideOutput, EchoGroupsInput, EchoGroupsOutput, EmitDemoInput, EmitDemoOutput, GaugeInput, GaugeOutput, GreetInput, GreetOutput, IsEvenInput, IsEvenOutput, KindEchoInput, KindEchoOutput, MultiplyInput, MultiplyOutput, PlatformNativeInfoOutput, ProcessItemInput, ProcessItemOutput, RegistryDemoInput, RegistryDemoOutput, ResourceCloseInput, ResourceCloseOutput, ResourceHandleOutput, ResourceOpenInput, ResourceReadInput, ResourceReadOutput, ResourceWriteInput, ResourceWriteOutput, ScoreTotalInput, ScoreTotalOutput, SecureComputeInput, SecureComputeOutput, SizeOfInput, SizeOfOutput, SpanInput, SpanOutput, SumListInput, SumListOutput, TagSetInput, TagSetOutput, ToUpperInput, ToUpperOutput, WideAggInput, WideAggOutput } from './types.js';
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

/**
 * 바이너리 채널 데모 — `channel_demo` 의 바이트 경로 쌍둥이. 모든 호스트 어댑터의 createBytesChannel/createChannelBytes 패리티를 동일 명령으로 e2e 검증한다(페이로드는 스텝 카운터 LE u64).
 */
export const channelDemoBytes = createGeneratedFields2<ChannelDemoBytesInput, ChannelDemoBytesOutput>(31, 'channelDemoBytes', "channel", "ticks", 'channelDemoBytes');

export function clamp(input: ClampInput, options?: InvokeOptions): Promise<ClampOutput> {
  return invokeGeneratedFields3<ClampOutput>(4, 'clamp', input, input["max"], input["min"], input["value"], options);
}
clamp.commandId = 'clamp';

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(8, 'createItem', "name", "value", 'createItem');

export function deviceDemo(options?: InvokeOptions): Promise<DeviceDemoOutput> {
  return invokeGenerated<DeviceDemoOutput>(32, 'deviceDemo', undefined, options);
}
deviceDemo.commandId = 'deviceDemo';

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

export function kindEcho(input: KindEchoInput, options?: InvokeOptions): Promise<KindEchoOutput> {
  return invokeGenerated<KindEchoOutput>(33, 'kindEcho', input, options);
}
kindEcho.commandId = 'kindEcho';

export const multiply = createGeneratedFields2<MultiplyInput, MultiplyOutput>(2, 'multiply', "a", "b", 'multiply');

export function platformNativeInfo(options?: InvokeOptions): Promise<PlatformNativeInfoOutput> {
  return invokeGenerated<PlatformNativeInfoOutput>(30, 'platformNativeInfo', undefined, options);
}
platformNativeInfo.commandId = 'platformNativeInfo';

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

## 11. 핫코어 (`hot-core` feature, experimental)

dev 타임 네이티브 핫스왑 — 호스트가 cdylib 코어를 열고, 감시 스레드가 아티팩트를
폴링하며, 재빌드된 바이트를 프로세스 재시작 없이 스왑한다. `hot-core` cargo
feature는 `libloading` 의존을 추가할 뿐 나머지는 움직이지 않는다 — 릴리스 빌드의
정적 링크 경로는 그대로다. 표면 전체가 experimental이다
([versioning-policy.ko.md](versioning-policy.ko.md)의 experimental 표) — 1.0 전에는
계약이 깨질 수 있다.

### 타입 목록 (`rustra::hot_core`)

- `JsonDispatch` — `pub trait JsonDispatch: Send + Sync`. 단일 메서드
  `fn invoke_json(&self, command: &str, args: serde_json::Value)` 는
  `Result<serde_json::Value, serde_json::Value>` 를 반환하고, 에러는 rustra 에러
  와이어 모양 `{"code": ..., "message": ...}` 로 돌아온다. `Package`(정적 경로)와
  `HotCoreHandle` 이 구현한다. `Send + Sync` 는 `Arc<dyn JsonDispatch>` 를 Tauri
  managed state 에 두기 위한 요구다(`JsonDispatch` 자체는 `hot-core` 없이도
  컴파일된다 — `tauri` 만 켠 호스트도 디스패치 간젡화를 잃지 않는다).
- `DylibCore` — `DylibCore::open(artifact: &Path) -> Result<Self, DylibCoreError>`
  (dlopen `RTLD_LOCAL`, 필수 심볼 바인딩, 계약 해시 조회);
  `.invoke_json(command, args)`; `.contract_hash()` 는
  `Result<String, DylibCoreError>` 를 반환.
- `DylibCoreError` — 변형 `Open`, `Symbol`, `ContractHash`, `Dispatch`,
  `Prepare`, `Codesign`, `Panic`. `Codesign` 은 macOS ad-hoc 재서명 실패를
  loudly 전파한다(조용한 스킵 없음). `Panic` 은 open/swap 경로의 패닉을 걸러
  감시 스레드와 호스트를 살려둔다.
- `HotCoreHandle` — `.new(core)`; `.swap(new: DylibCore) -> DylibCore` 는 구 코어를
  돌려준다 — 구 라이브러리는 의도적으로 절대 `dlclose` 하지 않는다;
  `.contract_hash()`; `JsonDispatch` 를 현재 코어로 라우팅해 구현한다.
- `prepare_swap_copy(artifact: &Path, counter: u64)` 는
  `Result<PathBuf, DylibCoreError>` 를 반환 — 아티팩트의 유일한 버전 카피를
  만들고(macOS에서 ad-hoc 재서명) 매핑된 원본을 덮어쓰지 않게 한다. 같은 경로를
  다시 dlopen 하면 stale 매핑이 돌아오기 때문이다.
- `SwapOutcome = Result<(String, String), DylibCoreError>` — Ok 는
  `(old_contract_hash, new_contract_hash)` 를 실운다. 콜백 타입은
  `Arc<dyn Fn(SwapOutcome) + Send + Sync>` (`on_swap` 의 원형).
- `DylibWatchConfig` — 필드 `artifact: PathBuf`, `poll: Duration`(기본 300ms),
  `handle: Arc<HotCoreHandle>`, `on_swap: SwapCallback`(기본 no-op); 생성자는
  `DylibWatchConfig::new(artifact, handle)`.
- `spawn_dylib_watch(config) -> std::thread::JoinHandle<()>` — sleep 폴링을 하는
  std 스레드(notify 계열 파일 감시 의존 없음). 아티팩트 sha256 을 폴링하고
  스왑을 원자적으로 적용한다.

### 재시도 상한

같은 아티팩트 바이트가 연속 5회 스왑에 실패하면 포이즌으로 표시되어 다른 바이트가
발행될 때까지 건너뛴다 — 각 실패는 여전히 `on_swap(Err(..))` 로 보고되고, 새
바이트는 언제나 새 재시도 창을 얻는다. 실패한 스왑이 기준선 해시를 갱신하지
않으므로, 빌드 중 반쯤 쓰인 아티팩트도 루프를 죽이지 않는다.

### Tauri 글루 (`tauri` + `hot-core`)

`tauri_support::HotSwapReporter`(`.new()`, `.report(outcome)`; `.install(sink)`
단계는 플러그인 내부라 공개 API 가 아니다)가 예약 채널 상수
`HOT_SWAP_EVENT = "hot-core/swapped"` 로 결과를 보고한다 — 웹뷰 채널은
`rustra://hot-core/swapped` 다. `tauri_support::register_dispatch_with_swap_events`
— 파라미터 `dispatch: Arc<dyn JsonDispatch>`, `reporter: HotSwapReporter`,
`builder: tauri::Builder<R>` (반환 `tauri::Builder<R>`) — 는 정적 디스패치에
`rustra-hot-swap` 플러그인을 얹어 리포터를 Tauri 이벤트 싱크에 설치한다.
`register_with_events` 와 달리 **패키지 이벤트는 배선되지 않는다**(스왑이 코어
내부 이벤트 싱크를 버리는 상태 소실 정책은 그대로) — 이 함수가 추가하는
emission 은 스왑 결과 1종뿐이다. JS 쪽에서 이 채널은 `@rustra/tauri` 의
`subscribeHotSwap` 가 소비한다
([events-and-channels.ko.md](events-and-channels.ko.md) 참고).

### 예제

```rust
use std::sync::Arc;
use rustra::hot_core::{self, DylibCore, DylibWatchConfig, HotCoreHandle};
use rustra::tauri_support::{self, HotSwapReporter};

// 1) 새로 빌드된 cdylib 을 열고 공유 스왑 지점으로 감싼다
let core = DylibCore::open(artifact)?;            // dlopen + 심볼 바인딩 + init
let handle = Arc::new(HotCoreHandle::new(core));  // Arc<dyn JsonDispatch> → Tauri state

// 2) 아티팩트를 감시; 모든 스왑 결과를 웹뷰 채널로 보고한다
let reporter = HotSwapReporter::new();
let mut config = DylibWatchConfig::new(artifact, handle.clone());
config.poll = std::time::Duration::from_millis(300); // 기본값 — 튜닝 지점 표시
let sink = reporter.clone();
config.on_swap = Arc::new(move |outcome| {
    eprintln!("rustra hot-core: swap {outcome:?}");
    sink.report(outcome.map_err(|e| e.to_string()));
});
hot_core::spawn_dylib_watch(config);              // std 스레드, sha256 폴링

// 3) 정적 디스패치 + rustra-hot-swap 플러그인
tauri_support::register_dispatch_with_swap_events(handle, reporter, builder)
```

설계·상태 문서:
[2026-09-09 네이티브 핫코어 설계](plans/2026-09-09-native-hot-core-design.md).
같은 루프의 React Native 쪽은
[`packages/react-native/README.md`](../packages/react-native/README.md).

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

타입 있는 이벤트 계약은 `.event::<T>(name)`으로 선언하면 코드젠이
`generated/events.ts`를 렌더링하고 JS 쪽이 타입 안전하게 구독한다. 선언 → 생성
`events.ts` → 호스트별 `subscribeEvent`/채널까지의 전체 흐름은
[이벤트·채널 가이드](events-and-channels.ko.md), 동작 예제는
[`examples/streaming`](../examples/streaming)에 있다.

**채널** — Rust → JS 유니캐스트 응답 스트림 (호출 스코프; 호스트별 발급 경로는
[호환성 매트릭스](compatibility-matrix.ko.md#채널-전달-경로) 참고):

```rust
use rustra::channels;

// 핸들을 발급하고 sender 설치 (호스트 어댑터는 이걸 대신 해준다 —
// 커스텀 호스트용 탈출구)
let host = channels::host();
let handle = host.reserve_handle();
host.register_channel_with_handle(handle, std::sync::Arc::new(move |payload: &str| {
    // `payload` 를 JS 쪽으로 전달 (emit, stdout 프레임, FFI 콜백, …)
}));

// 커맨드의 ChannelHandle 인자로 호출자에게 응답을 보낸다
assert!(channels::ChannelHandle(input.channel).send(r#"{"progress": 1}"#));
// 이미 드랍된 핸들은 false (조용히-무시 계약이 보이는 형태)
host.drop_channel(handle); // 이후 send 는 false 반환
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
- `tauri_support::register_profiled(...)` — 벤치 전용, `rustra_dispatch_profiled` 노출
- `tauri_support::rustra_dispatch(...)` — 커맨드 디스패치
- `tauri_support::register_dispatch_with_swap_events(...)` — 핫코어 스왑 보고
  (`rustra://hot-core/swapped` 채널, §11 참고)

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
            "math.divide_by_zero",
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
공유하므로 가드가 자동으로 함께 적용된다. 현재 `ownerId` 를 전달하는 어댑터는
Node 뿐이라 — 나머지 어댑터의 충돌 진단은 익명 주체로 보고된다.
