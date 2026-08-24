# rustra 시작하기

rustra는 Rust 패키지를 한 번 정의하면 Node, Bun, Tauri, React Native 어디에서나 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다.

이 가이드는 rustra를 처음 사용하는 개발자가 10분 안에 첫 패키지를 만들고 TypeScript 클라이언트를 생성하는 것을 목표로 한다.

---

## 1. 설치

### 가장 빠른 시작 — `rustra init`

```bash
bunx --bun @rustra/cli@0.4.0 init my-project
cd my-project
bun install
bun run codegen      # schema.json + 완전한 TS/C++ 클라이언트 생성
cargo run            # 생성된 echo 커맨드를 실제 호출
```

스캐폴드는 Cargo 크레이트(echo 예제 커맨드 포함) + `generate` bin +
package.json(codegen 스크립트)를 만든다.

### 외부 프로젝트에서 사용

```toml
[dependencies]
rustra = "0.4"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

TypeScript 어댑터는 사용할 환경만 설치하면 된다:

```bash
bun add @rustra/node      # Node.js
bun add @rustra/bun       # Bun
bun add @rustra/tauri     # Tauri
bun add @rustra/react-native  # React Native
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

| crate                | 역할                                                           |
| -------------------- | -------------------------------------------------------------- |
| `rustra`             | Package builder, TypeScript 생성기, JSON Schema 기반 타입 매핑 |
| `rustra-macros`      | `#[command]` 속성 매크로 (rustra가 자동으로 재export)          |
| `serde` + `schemars` | 직렬화/역직렬화 + JSON Schema 생성. 타입에 3개 derive 필요     |

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
cargo run -p rustra-calculator-example --bin rustra-calculator-example
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

export function addNumbers(
  engine: EngineClient,
  input: AddNumbersInput,
): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}
```

- 각 `#[command]` 함수마다 TypeScript 함수가 하나씩 생성된다.
- `engine` 파라미터로 `EngineClient`를 받아 `invoke`를 호출한다.
- 커맨드명(`addNumbers`), 입력 타입, 출력 타입이 모두 타입 안전하게 연결된다.

### contract.ts — 계약 해시

```ts
export const GENERATED_CONTRACT_HASH =
  '5ed9d6dc29fb1b0d437b110a8f48e0cb828cc1e27a562b79049e86975b970aba';
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
        "properties": {
          "a": { "type": "integer", "format": "int64" },
          "b": { "type": "integer", "format": "int64" }
        },
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

생성된 TypeScript 계약은 호스트에 종속되지 않는다. 일반 앱은 플랫폼 진입점이
`EngineClient`를 lazy 설치하므로 엔진을 직접 만들거나 `configure()`하지 않는다.

rustra는 4개의 공식 어댑터 패키지를 제공한다.

### Node

`rustra.json`에 빈 Node 블록을 추가한다.

```json
{ "schema": "./generated/schema.json", "output": "./generated", "node": {} }
```

```ts
import { addNumbers } from '../generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
```

코드젠은 Cargo metadata의 기본 binary와 target directory를 고정한다. Release를
먼저 사용하고 Debug로 폴백하며, transpile 뒤에는 현재 작업 디렉터리의 부모에서 같은
Cargo target을 찾는다. 배포 디렉터리가 다르면 `RUSTRA_NODE_BINARY`를 지정한다.
표준 runtime은 `{command, args}` → `{ok, result}` one-shot stdio protocol을 구현해야
한다. calculator의 `run_invoke_stdio`가 참조 구현이다.

**커스텀 transport (napi-rs 등):**

```ts
import { createNodeEngine } from '@rustra/node';

const engine = createNodeEngine({
  invoke(command, args) {
    // napi 애드온 직접 호출 등 자체 transport
    return nativeAddon.invoke(command, JSON.stringify(args));
  },
});
```

`createNodeEngine`, `createNodeProcessTransport`, `createNodeLoopTransport`는 custom
N-API와 다중 runtime을 위한 명시적 escape hatch다.

### Bun

Rust library는 `crate-type = ["rlib", "cdylib"]`과
`rustra::native_entry!(app_package)`를 선언한다. 설정에는 빈 Bun 블록만 둔다.

```json
{ "schema": "./generated/schema.json", "output": "./generated", "bun": {} }
```

```ts
import { addNumbers } from '../generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });
```

생성 진입점은 Release/Debug cdylib 후보를 실제 ABI 심볼까지 검사하고 Bun FFI의 stable
C ABI를 rkyv V2 engine에 연결한다. Rust 응답은 JS 소유 `ArrayBuffer`로 복사한 뒤
정확한 pointer/length로 해제한다. 다른 배포 레이아웃은 `RUSTRA_BUN_LIBRARY`로 지정한다.

### Tauri

Tauri의 `app.withGlobalTauri`를 켜고 설정에 `"tauri": {}`를 추가한다.

```ts
import { addNumbers, subscribeEvent } from '../generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
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

#### rkyv V2 (권장 — postcard 바이너리 + JSI 동기 호출)

JSI 동기 호출과 postcard 바이너리 직렬화를 사용한다. Rust 측에는 앱 package와
native entry를 한 번 선언한다.

**Rust 측 설정:**

```rust
use rustra::prelude::*;

pub fn my_package() -> Package {
    register!(Package::builder("my.pkg"), add_numbers, multiply).build()
}

rustra::native_entry!(my_package);
```

`Cargo.toml`의 `[lib]`에는 `crate-type = ["rlib", "staticlib"]`를 둔다.

**단일 설정:**

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "positional": true,
  "reactNative": {}
}
```

```bash
bunx --bun @rustra/cli generate --config rustra.json
```

**TypeScript 측 사용:**

```ts
import { addNumbers } from '../generated/react-native';

const result = await addNumbers({ a: 20, b: 22 }); // JSI fast path
```

생성된 진입점이 첫 호출에서 JSI 설치, contract hash/schema version 검증,
`rkyvV2Registry` 고속 엔진 설정을 동시 호출에도 한 번만 수행한다. 실패한 설치는 다음
호출에서 재시도하고, 앱이 명시적으로 `configure()`한 엔진은 늦게 끝난 설치가 덮어쓰지
않는다. 생성기는 Cargo package/library를 추론하고 앱 전용
`@rustra/generated-react-native` package에 Podspec, Gradle/CMake/JNI와 공유 C++
bridge를 만든다. Expo development build와 bare RN 모두 표준 autolinking을 쓰며,
앱 코드에는 install/configure 보일러플레이트가 남지 않는다. Expo Go는 지원하지 않는다.

2026-08-24 Release 성능은 동일 공개 객체 연산의 Nitro 대비 3회 중앙값
add 1.0297x, string 1.0229x, bytes 0.9219x, pair 1.0656x다. 최신 러너는
Nitro/Rustra/FFI 순환 측정, paired 95% CI, 생성 helper/native 경로 진단을
포함하며 Bun 명령으로 JSON receipt를 자동 추출한다. 비교 범위와 기능 패리티 매트릭스는
[벤치마크 문서](benchmarks.md) §"Nitro Modules 비교" 참고.

**C++ 코덱 코드젠:** `reactNative`가 활성화되면
`rustra-generated-codecs.{hpp,cpp}`도 generated package 내부에 자동 배치되고
iOS와 Android build에 포함된다. Xcode/Podspec/Gradle에 파일을 수동 추가하지 않는다.
자세한 설정은 [React Native 셋업 가이드](extending/react-native-setup.md) 참고.

저장소의 React Native calculator 예시는 `bun run doctor`로 Bun 1.4, Rust schema와
TypeScript/native codec 동기화, Expo/Pod 연결, Rust iOS target, static archive 최신성,
필수 `extern "C"` 심볼, 설치된 Release receipt를 읽기 전용으로 검사한다. 실패마다
`bun run codegen`, `cd ios && pod install`, `bun run rust:ios`, Release 재빌드 중 어느
층을 복구해야 하는지 구체적으로 안내하므로 네이티브 문제를 TypeScript 문제로 오인하지
않게 한다. CI용 구조화 결과는 `bun run doctor -- --json`으로 얻을 수 있다.

#### JSON (저수준 transport 호환성)

```ts
import { createReactNativeEngine } from '@rustra/react-native';
import { configure } from '@rustra/types';
import { addNumbers } from '../generated/commands.js';
import { customNativeTransport } from './native-transport';

const engine = createReactNativeEngine(customNativeTransport);
configure(engine);

const result = await addNumbers({ a: 20, b: 22 });
```

이 경로는 custom transport를 직접 소유할 때만 사용한다. 일반 앱은 generated
`react-native.ts`의 caller-buffer fast path를 사용한다.

### 요약

| 환경         | 기본 생성 진입점                     | 자동 연결                           | 성능 (release)                      |
| ------------ | ------------------------------------ | ----------------------------------- | ----------------------------------- |
| Node         | `generated/node.ts`                  | Cargo binary + stdio                | ~3.4 ms historical; N-API는 ~1.5 µs |
| Bun          | `generated/bun.ts`                   | Cargo cdylib + stable FFI + rkyv V2 | ~1.7 µs FFI                         |
| Tauri        | `generated/tauri.ts`                 | global invoke/event                 | IPC 종속                            |
| React Native | generated `react-native.ts`          | autolinked JSI + postcard codecs    | Nitro 근접; 최신 receipt 확인       |
| React Native | `createReactNativeEngine(transport)` | custom JSON transport               | transport 구현 종속                 |

> Node/Bun의 ~24/27µs는 debug 네이티브 라이브러리를 로드했을 때 값이다 —
> release 빌드에서는 single-digit µs 범위로 좁혀진다. 측정 세션별 수치는
> [벤치마크 문서](benchmarks.md) 참고 (2026-08-23 RN 재측정).

모든 어댑터가 `EngineClient`를 반환하므로, 이후 코드는 환경에 상관없이 동일하다.

```ts
// 플랫폼 진입점 import가 bootstrap을 소유한다.
const result = await addNumbers({ a: 20, b: 22 });
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
cargo run -p rustra-calculator-example --bin rustra-calculator-example
```

`generated/` 디렉토리에 TypeScript 파일이 생성되었는지 확인한다.

### 전체 호환성 테스트

```bash
bun run test:compat
```

이 명령어는 다음을 모두 실행한다.

| 스크립트        | 내용                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `test:ts:node`  | Node로 생성된 클라이언트 타입 검증                                                   |
| `test:ts:bun`   | Bun으로 생성된 클라이언트 타입 검증                                                  |
| `test:adapters` | 4개 어댑터가 모두 동일한 커맨드를 올바르게 전달하는지 확인                           |
| `test:runtime`  | Node, Bun 런타임에서 실제 Rust 프로세스 호출, Tauri 앱 빌드 및 WebView에서 호출 검증 |

개별 실행도 가능하다.

```bash
# 어댑터만 테스트
bun run test:adapters

# Node 런타임만 테스트 (Rust 빌드 포함)
bun run test:runtime:node

# Tauri 런타임만 테스트
bun run test:runtime:tauri
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
    "build": "bun run build:rust && bun run build:ts",
    "dev": "bun run build:rust && tsc --watch"
  }
}
```

`cargo run`에서 `generate` 서브커맨드를 처리하도록 `main.rs`를 작성하면 된다:

```rust
fn main() -> rustra::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("generate") {
        let package = my_package();
        package.generate_typescript()?.write_to_dir("generated")?;
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
fn divide(input: DivideInput) -> Result<DivideOutput> {
    if input.b == 0 {
        return Err(RustraError::custom("division.by_zero", "cannot divide by zero"));
    }
    Ok(DivideOutput { value: input.a / input.b })
}
```

에러 코드 종류:

| 에러 코드              | 발생 조건                            |
| ---------------------- | ------------------------------------ |
| `command.not_found`    | 존재하지 않는 커맨드 호출            |
| `command.invalid_args` | 입력 JSON 역직렬화 실패              |
| `internal`             | 내부 오류 (직렬화 실패, I/O 등)      |
| custom (지정한 코드)   | `RustraError::custom(code, message)` |

### TypeScript 측

커맨드 호출이 실패하면 어댑터가 에러를 throw한다. Tauri 어댑터는 `RustraCommandError` 클래스를 제공한다:

```ts
import { RustraCommandError } from '@rustra/tauri';

try {
  const result = await divide(engine, { a: 10, b: 0 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code); // "division.by_zero"
    console.log(e.message); // "cannot divide by zero"
  }
}
```

Node, Bun, React Native 어댑터는 transport 구현에 따라 에러 형태가 달라진다. 공통적으로 에러 응답은 `{ ok: false, error: { code, message } }` 형태의 JSON이다.

---

## 8. TypeScript 타입 매핑

대부분의 Rust 타입이 TypeScript로 올바르게 변환된다:

| Rust 타입                           | TypeScript                      | 비고                                    |
| ----------------------------------- | ------------------------------- | --------------------------------------- |
| `String`, `&str`                    | `string`                        |                                         |
| `i32`/`i64`/`u32`/`f32`/`f64`       | `number`                        | 64비트 정수는 JS safe integer 범위 권장 |
| `bool`                              | `boolean`                       |                                         |
| `Option<T>`                         | `T \| null` (필드는 선택적 `?`) |                                         |
| `Vec<T>`                            | `T[]`                           |                                         |
| `BTreeSet<T>` / `HashSet<T>`        | `Set<T>`                        | `uniqueItems` — JSON 경로는 배열 직렬화 |
| `(A, B, C)`                         | `[A, B, C]`                     | 튜플                                    |
| `HashMap<String, T>`                | `Record<string, T>`             |                                         |
| `enum` (unit variants)              | `'VariantA' \| 'VariantB'`      | string enum 리터럴 union                |
| 중첩 구조 (`Box<T>`, `Vec<T>` 내부) | 정의 이름 `$ref` 해석           | 재귀 타입(self-reference) 포함          |
| `anyOf` / `oneOf`                   | `A \| B` (union join)           |                                         |

`allOf`는 `A & B`, integer enum은 숫자 리터럴 union, `oneOf`+`const`는 판별
union으로 생성된다. postcard fast path(rkyv V2 코덱)는 primitive,
Vec/Set/tuple, 원시값 map, string enum, 중첩 구조체, 그리고 single-entry
`allOf` newtype 핸들을 지원한다. 선언순을 스키마의
`fieldOrder: "declaration"`로 보증할 수 없는 레거시 스키마는 코드젠이 경고한다.

현재 data enum(`oneOf`의 payload variant), 구조체 값 map, collection/enum을
감싼 일부 `Option<T>` 조합은 정확한 와이어 순서를 스키마만으로 증명할 수 없어
명령 전체가 JSON-in-binary(Tier 3)로 자동 폴백한다. 필드는 조용히 삭제되지 않는다.

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
TypeScript에서 createXxxEngine(transport) + configure(engine) + addNumbers(input) 호출
```
